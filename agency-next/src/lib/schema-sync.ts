/**
 * Applying the additive parts of the schema from inside the portal.
 *
 * The app degrades gracefully when a column it wants isn't there yet (see
 * `hasColumn`), which keeps a deploy safe but leaves the feature quietly
 * switched off until someone runs `database/migrate.js`. On a hosted database
 * with no shell to hand, that "someone" never gets round to it and a column
 * stays missing for weeks.
 *
 * So the super admin can apply them from Settings. Deliberately narrow:
 *
 *   - only the statements written out below, never anything from a request
 *   - only ADD COLUMN and CREATE TABLE IF NOT EXISTS, so nothing existing can
 *     be altered or dropped
 *   - skipped when the column is already there, so it's safe to run twice
 *
 * `database/migrate.js` remains the source of truth and does the same work;
 * this is the same list reachable without a terminal.
 */
import "server-only";
import { query, executeDdl, forgetColumn } from "./db";

type ColumnSpec = {
  table: string;
  column: string;
  /** The full column definition, exactly as migrate.js writes it. */
  definition: string;
  /** What the column is for, shown in Settings. */
  purpose: string;
  /**
   * Set when the column already exists and it is an ENUM that needs another
   * permitted value — a new role, say. "Missing" then means the value isn't
   * in the enum, and applying runs MODIFY rather than ADD.
   *
   * Widening an enum is additive in effect: existing rows keep their values
   * and nothing is dropped. The one way it could destroy data is a definition
   * that omits a value some row is already using, which MySQL would truncate
   * to an empty string — so `applyPendingColumns` refuses any MODIFY that
   * would drop a value the column currently permits.
   */
  requiresEnumValue?: string;
};

const EXPECTED: ColumnSpec[] = [
  /*
   * How long people actually watched, which is the outcome that matters most
   * for a reel and the one nothing was keeping.
   *
   * Reach says how many were shown it; these say whether they stayed. Meta
   * returns both in milliseconds on `ig_reels_avg_watch_time` and
   * `ig_reels_video_view_total_time`, and with `deliverables.video_duration`
   * already on the row, average watch over duration is retention — without
   * which "this one did well" is a guess about a number nobody has.
   */
  {
    table: "post_insights",
    column: "avg_watch_ms",
    definition: "avg_watch_ms BIGINT NULL AFTER views",
    purpose: "Average time a reel was watched for, in milliseconds.",
  },
  {
    table: "post_insights",
    column: "total_watch_ms",
    definition: "total_watch_ms BIGINT NULL AFTER avg_watch_ms",
    purpose: "Total time a reel was watched for, across everyone who saw it.",
  },
  /*
   * Whether a person is on screen — the one feature in the list the portal
   * could not already answer, and the one an agency argues about most.
   *
   * The model is already watching the whole video to write the caption, so
   * this costs nothing extra to ask for; it is a field in a reply that was
   * being made anyway.
   */
  /*
   * How a model with no video input still watches a video.
   *
   * The model takes images and audio, never a video file. So the browser — which
   * is holding the file anyway, at the moment it uploads it — decodes frames
   * across the whole runtime and puts them in R2, and the speech is read out
   * of the same mp4 by the transcription endpoint. These two columns are what
   * makes that repeatable: an analysis can be re-run months later without the
   * browser, and a retry never pays to transcribe the same audio twice.
   */
  {
    table: "video_analysis",
    column: "frames_json",
    definition: "frames_json LONGTEXT NULL",
    purpose:
      "R2 keys of the frames decoded from this video, in order, so what the model looked at can be looked at again.",
  },
  {
    table: "video_analysis",
    column: "transcript",
    definition: "transcript LONGTEXT NULL",
    purpose: "What is actually said in the video, in the language it was said in.",
  },
  /*
   * When a caption was actually written for this video, so it can be capped.
   *
   * A generation reads a dozen high-detail frames at the highest reasoning
   * effort the portal buys anywhere — by far its most expensive call. A
   * "Regenerate" button next to it and no ceiling is an open tab against a
   * prepaid balance, and the honest ceiling is per video rather than per day:
   * three attempts is more than enough to get one reel's copy right, and a
   * fourth is somebody hoping a different answer falls out.
   */
  /*
   * Where a Page post actually lives, in Meta's own words.
   *
   * A Page video is published to /videos, which answers with a bare video id
   * and no post id at all — so a link assembled from that id is a guess about
   * which surface it lives on, and the guess opened somebody else's content.
   * Meta will say exactly where it is if asked, so it is asked and the answer
   * kept.
   */
  {
    table: "deliverables",
    column: "facebook_permalink",
    definition: "facebook_permalink VARCHAR(500) DEFAULT NULL",
    purpose: "The Facebook Page post's own link, as Meta reports it.",
  },
  {
    table: "video_analysis",
    column: "gen_log",
    definition: "gen_log VARCHAR(500) NULL",
    purpose:
      "When captions were written for this video (UTC), so it can be limited to three in 48 hours.",
  },
  {
    table: "video_analysis",
    column: "has_face",
    definition: "has_face TINYINT(1) NULL AFTER mood",
    purpose: "Whether a person appears on camera, as read from the video.",
  },
  {
    table: "clients",
    column: "is_personal",
    definition: "is_personal TINYINT(1) NOT NULL DEFAULT 0",
    purpose: "Marks a client as the agency's own, so it can be kept out of reports.",
  },
  {
    table: "clients",
    column: "monthly_posters",
    definition: "monthly_posters INT UNSIGNED NOT NULL DEFAULT 0",
    purpose: "Monthly poster target, counted separately from videos.",
  },
  {
    table: "clients",
    column: "category",
    definition: "category VARCHAR(10) NOT NULL DEFAULT ''",
    purpose: "The A / B / C tier shown in the Category column of the monthly report.",
  },
  {
    table: "deliverables",
    column: "reference_links",
    definition: "reference_links TEXT DEFAULT NULL",
    purpose: "Reference links, for when a client sends no raw footage.",
  },
  {
    table: "deliverables",
    column: "cloud_video_url",
    definition: "cloud_video_url VARCHAR(600) DEFAULT NULL",
    purpose: "Public URL of an uploaded video, when the bucket has one.",
  },
  {
    table: "deliverables",
    column: "cloud_video_key",
    definition: "cloud_video_key VARCHAR(400) DEFAULT NULL",
    purpose: "Object key of an uploaded video — what signed links are built from.",
  },
  {
    table: "deliverables",
    column: "uploaded_by",
    definition: "uploaded_by BIGINT UNSIGNED DEFAULT NULL",
    purpose:
      "Who uploaded the finished video. The efficiency report counts the person who did the work, which is not always the person the task is assigned to.",
  },

  /* --- Instagram auto-publishing (the n8n workflow's handshake) --- */
  {
    table: "deliverables",
    column: "hashtags",
    definition: "hashtags TEXT DEFAULT NULL",
    purpose: "Hashtags kept apart from the caption, appended when the post goes out.",
  },
  {
    table: "deliverables",
    column: "instagram_media_id",
    definition: "instagram_media_id VARCHAR(64) DEFAULT NULL",
    purpose: "The Instagram media id returned once a post is published.",
  },
  {
    table: "deliverables",
    column: "instagram_permalink",
    definition: "instagram_permalink VARCHAR(500) DEFAULT NULL",
    purpose: "Public link to the published post.",
  },
  {
    table: "deliverables",
    column: "instagram_posted_at",
    definition: "instagram_posted_at DATETIME DEFAULT NULL",
    purpose: "When Instagram accepted the post.",
  },
  {
    table: "deliverables",
    column: "post_attempts",
    definition: "post_attempts INT UNSIGNED NOT NULL DEFAULT 0",
    purpose: "How many publish attempts have been spent, so retries can give up.",
  },
  {
    table: "deliverables",
    column: "post_error",
    definition: "post_error TEXT DEFAULT NULL",
    purpose: "The last publishing failure, shown in the portal.",
  },
  {
    table: "deliverables",
    column: "post_locked_at",
    definition: "post_locked_at DATETIME DEFAULT NULL",
    purpose: "Claim lease — stops two automation runs posting the same video twice.",
  },
  {
    table: "users",
    column: "avatar_url",
    // Matches database/schema.sql exactly. It is in the base schema already,
    // so this entry only ever fires for a database that predates it — but a
    // second definition that disagreed on the width would be worse than none.
    definition: "avatar_url VARCHAR(500) DEFAULT NULL",
    purpose:
      "A staff member's own profile picture — an uploaded object key, or a pasted URL. Clients already had one; everybody else was two letters in a circle.",
  },
  {
    table: "users",
    column: "daily_target",
    definition: "daily_target INT UNSIGNED NOT NULL DEFAULT 0",
    purpose:
      "How many tasks this person is expected to finish a day. 0 means no target is set for them.",
  },
  {
    table: "clients",
    column: "content_approval",
    definition: "content_approval TINYINT(1) NOT NULL DEFAULT 1",
    purpose:
      "Does this client sign off the written content before work starts? On by default; off hands it straight to the team.",
  },
  {
    table: "deliverables",
    column: "facebook_status",
    definition: "facebook_status VARCHAR(20) NOT NULL DEFAULT 'not_posted'",
    purpose:
      "Whether the same post reached the client's Facebook Page — posted, failed, or not attempted.",
  },
  {
    table: "deliverables",
    column: "facebook_post_id",
    definition: "facebook_post_id VARCHAR(64) DEFAULT NULL",
    purpose:
      "The Page post's id, which the task page links to.",
  },
  {
    table: "deliverables",
    column: "facebook_error",
    definition: "facebook_error TEXT DEFAULT NULL",
    purpose:
      "Why the Page refused it, in words that say what to change.",
  },
  {
    table: "deliverables",
    column: "content_sent_at",
    definition: "content_sent_at DATETIME DEFAULT NULL",
    purpose: "When the written brief went to the client, so a second send is a deliberate one.",
  },
  {
    table: "clients",
    column: "auto_reminders",
    definition: "auto_reminders TINYINT(1) NOT NULL DEFAULT 1",
    purpose:
      "Chase this client on WhatsApp for footage, approvals and the month's plan. On by default; off for a client who would rather hear from a person.",
  },
  {
    table: "clients",
    column: "provides_footage",
    definition: "provides_footage TINYINT(1) NOT NULL DEFAULT 1",
    purpose:
      "Whether this client sends us raw footage at all. Off for one we film ourselves, or whose work is posters and ads — their group is then never asked for rushes that were never going to exist.",
  },
  {
    table: "clients",
    column: "auto_payment_reminders",
    definition: "auto_payment_reminders TINYINT(1) NOT NULL DEFAULT 0",
    purpose:
      "Chase this client's overdue invoices on WhatsApp automatically, with a payment link. Off unless chosen.",
  },
  /*
   * The three kinds of message that had no switch at all.
   *
   * Approvals, footage and payments already had one each; the monthly report,
   * the "your post is live" link and the assistant's replies went to everybody
   * whether they wanted them or not. A client asking for less had nothing to
   * turn off. All default to 1 — nothing changes for anybody until somebody
   * unticks a box.
   */
  {
    table: "clients",
    column: "send_reports",
    definition: "send_reports TINYINT(1) NOT NULL DEFAULT 1",
    purpose: "Send this client their monthly report.",
  },
  {
    table: "clients",
    column: "send_posted_links",
    definition: "send_posted_links TINYINT(1) NOT NULL DEFAULT 1",
    purpose: "Message this client the link when a post of theirs goes live.",
  },
  {
    table: "clients",
    column: "ai_replies",
    definition: "ai_replies TINYINT(1) NOT NULL DEFAULT 1",
    purpose: "Let the assistant answer ordinary messages in this client's groups.",
  },
  {
    table: "clients",
    column: "ads_access_token",
    definition: "ads_access_token TEXT DEFAULT NULL",
    purpose:
      "A User or System User token with ads_read for this client. A Page token cannot read spend.",
  },
  {
    table: "clients",
    column: "meta_ad_account_id",
    definition: "meta_ad_account_id VARCHAR(64) DEFAULT NULL",
    purpose: "The client's Meta ad account (act_…), so their spend can be read from Meta.",
  },

  /* --- YouTube, posted alongside Instagram by the n8n runner --- */
  {
    table: "clients",
    column: "youtube_enabled",
    definition: "youtube_enabled TINYINT(1) NOT NULL DEFAULT 0",
    purpose: "Opt-in to posting this client's videos to YouTube as well. Off unless asked for.",
  },
  {
    table: "clients",
    column: "youtube_channel_id",
    definition: "youtube_channel_id VARCHAR(64) DEFAULT NULL",
    purpose: "Which channel to upload to, when the connected account owns several.",
  },
  {
    table: "deliverables",
    column: "youtube_status",
    definition:
      "youtube_status VARCHAR(20) NOT NULL DEFAULT 'none'", // none|scheduled|processing|posted|failed
    purpose: "Where this video is in the YouTube queue — the column the runner selects on.",
  },
  {
    table: "deliverables",
    column: "youtube_video_id",
    definition: "youtube_video_id VARCHAR(32) DEFAULT NULL",
    purpose: "The uploaded video's YouTube id.",
  },
  {
    table: "deliverables",
    column: "youtube_url",
    definition: "youtube_url VARCHAR(255) DEFAULT NULL",
    purpose: "Watch link, for the task page and the client's report.",
  },
  {
    table: "deliverables",
    column: "youtube_posted_at",
    definition: "youtube_posted_at DATETIME DEFAULT NULL",
    purpose: "When it went live on YouTube.",
  },
  {
    table: "deliverables",
    column: "youtube_attempts",
    definition: "youtube_attempts INT UNSIGNED NOT NULL DEFAULT 0",
    purpose: "Upload attempts so far — the budget that stops a broken video retrying for ever.",
  },
  {
    table: "deliverables",
    column: "youtube_error",
    definition: "youtube_error TEXT DEFAULT NULL",
    purpose: "Why the last upload failed, in YouTube's own words.",
  },
  {
    table: "deliverables",
    column: "youtube_locked_at",
    definition: "youtube_locked_at DATETIME DEFAULT NULL",
    purpose: "Claim lease — stops two runs uploading the same video twice.",
  },

  {
    table: "clients",
    column: "editor_id",
    definition: "editor_id BIGINT UNSIGNED DEFAULT NULL",
    purpose: "The client's default video editor — the video half of the pair with designer_id.",
  },
  {
    table: "clients",
    column: "ig_username",
    definition: "ig_username VARCHAR(100) DEFAULT NULL",
    purpose: "The client's Instagram @handle.",
  },
  {
    table: "clients",
    column: "ig_access_token",
    definition: "ig_access_token TEXT DEFAULT NULL",
    purpose: "Optional per-client Meta token; blank uses the agency-wide one.",
  },
  {
    table: "clients",
    column: "whatsapp_number",
    definition: "whatsapp_number VARCHAR(30) DEFAULT NULL",
    purpose: "Where the 'your post is live' WhatsApp message goes.",
  },
  {
    table: "clients",
    column: "auto_publish",
    definition: "auto_publish TINYINT(1) NOT NULL DEFAULT 0",
    purpose: "Opt-in to unattended posting. Off unless the client agrees to it.",
  },

  /* --- WhatsApp client approvals --- */
  {
    table: "deliverables",
    column: "video_code",
    definition: "video_code VARCHAR(20) DEFAULT NULL",
    purpose: "The short code (V245) a client types into WhatsApp to approve a video.",
  },
  {
    table: "deliverables",
    column: "wa_status",
    definition: "wa_status VARCHAR(24) NOT NULL DEFAULT 'not_sent'",
    purpose: "Where the WhatsApp approval has got to: sent, viewed, approved, and so on.",
  },
  {
    table: "deliverables",
    column: "wa_group_id",
    definition: "wa_group_id VARCHAR(64) DEFAULT NULL",
    purpose: "Which WhatsApp group the video was sent to.",
  },
  /*
   * What a client's group is *for*.
   *
   * A client is often in more than one group with us, and the people who sign
   * off the work are rarely the people who pay for it. Every one of these
   * defaults to 1, so a database that applies them keeps behaving exactly as
   * it did until somebody unticks a box.
   */
  /*
   * The columns an ad table is actually read for.
   *
   * `engagement` and `ad_status` had no home at all; `reach_window` has one
   * of its own because reach is the single metric that cannot be added up —
   * see the note on it below.
   */
  {
    table: "ad_performance",
    column: "engagement",
    definition: "engagement INT NULL",
    purpose: "Post engagements — reactions, comments, shares, saves, taps.",
  },
  {
    table: "ad_performance",
    column: "ad_status",
    definition: "ad_status VARCHAR(32) DEFAULT NULL",
    purpose: "Whether the ad is still delivering: ACTIVE, PAUSED, and so on.",
  },
  {
    table: "ad_performance",
    column: "reach_window",
    /*
     * Reach for the whole sync window, as Meta counts it — not a sum.
     *
     * Reach is people, and the same person reached on Monday and Tuesday is
     * one person. Adding the daily figures produces a bigger, wronger number
     * that looks exactly like the right one, and there is no way to recover
     * the true figure from stored daily rows. So Meta is asked for the window
     * without `time_increment`, which is the number Ads Manager itself shows,
     * and it is stored against the window it describes.
     */
    definition: "reach_window INT NULL",
    purpose: "Deduplicated reach for the sync window — never a sum of daily reach.",
  },
  {
    table: "ad_performance",
    column: "reach_window_days",
    definition: "reach_window_days INT NULL",
    purpose: "How many days reach_window covers, so it is never shown for a range it does not fit.",
  },
  {
    table: "ad_performance",
    column: "adset_id",
    definition: "adset_id VARCHAR(40) DEFAULT NULL",
    purpose: "Which ad set the ad belongs to — targeting lives there, not on the ad.",
  },
  {
    table: "ad_performance",
    column: "locations",
    /* Where it ran, in words. Two ads with identical numbers are completely
       different pieces of work if one was Hyderabad and the other all India. */
    definition: "locations VARCHAR(500) DEFAULT NULL",
    purpose: "Where the ad was aimed — the cities, regions or countries in its targeting.",
  },
  {
    table: "ad_performance",
    column: "link_clicks",
    /* NULL, not 0. Meta does not report every action type on every account,
       and a confident zero reads to a client as "nobody did it". */
    definition: "link_clicks INT NULL",
    purpose: "Clicks through to the link — the client's own question, not spend.",
  },
  {
    table: "ad_performance",
    column: "video_views",
    /* NULL, not 0. Meta does not report every action type on every account,
       and a confident zero reads to a client as "nobody did it". */
    definition: "video_views INT NULL",
    purpose: "How many people watched the video, from Meta's own action count.",
  },
  {
    table: "ad_performance",
    column: "profile_visits",
    /* NULL, not 0. Meta does not report every action type on every account,
       and a confident zero reads to a client as "nobody did it". */
    definition: "profile_visits INT NULL",
    purpose: "How many went and looked at the profile afterwards.",
  },
  /*
   * Reach for the account, over the window, as Meta counts it.
   *
   * The daily `reach` column cannot be added up and neither can the per-ad
   * one: reach is people, the same person reached twice is one person, and two
   * ads reaching overlapping audiences do not add either. Only Meta can
   * deduplicate it, so it is asked for at account level over the whole window
   * and stored with the window it describes.
   */
  {
    table: "ad_insights",
    column: "reach_window",
    definition: "reach_window INT NULL",
    purpose: "Accounts reached over the sync window — never a sum of daily or per-ad reach.",
  },
  {
    table: "ad_insights",
    column: "reach_window_days",
    definition: "reach_window_days INT NULL",
    purpose: "How many days reach_window covers, so it is never quoted for another period.",
  },
  {
    table: "ad_insights",
    column: "link_clicks",
    /* NULL, not 0. Meta does not report every action type on every account,
       and a confident zero reads to a client as "nobody did it". */
    definition: "link_clicks INT NULL",
    purpose: "Clicks through to the link — the client's own question, not spend.",
  },
  {
    table: "ad_insights",
    column: "video_views",
    /* NULL, not 0. Meta does not report every action type on every account,
       and a confident zero reads to a client as "nobody did it". */
    definition: "video_views INT NULL",
    purpose: "How many people watched the video, from Meta's own action count.",
  },
  {
    table: "ad_insights",
    column: "profile_visits",
    /* NULL, not 0. Meta does not report every action type on every account,
       and a confident zero reads to a client as "nobody did it". */
    definition: "profile_visits INT NULL",
    purpose: "How many went and looked at the profile afterwards.",
  },
  {
    table: "whatsapp_groups",
    column: "for_approvals",
    definition: "for_approvals TINYINT(1) NOT NULL DEFAULT 1",
    purpose: "Send approvals, the 12-hour chase and footage requests to this group.",
  },
  {
    table: "whatsapp_groups",
    column: "for_footage",
    definition: "for_footage TINYINT(1) NOT NULL DEFAULT 1",
    purpose: "Ask this group for raw footage before a shoot is due.",
  },
  {
    table: "whatsapp_groups",
    column: "for_payments",
    definition: "for_payments TINYINT(1) NOT NULL DEFAULT 1",
    purpose: "Send invoices and overdue reminders to this group.",
  },
  {
    table: "whatsapp_groups",
    column: "for_updates",
    definition: "for_updates TINYINT(1) NOT NULL DEFAULT 1",
    purpose: "Send the month's plan, reports and 'your post is live' to this group.",
  },
  {
    table: "whatsapp_groups",
    column: "for_chat",
    definition: "for_chat TINYINT(1) NOT NULL DEFAULT 1",
    purpose: "Let the assistant answer ordinary messages in this group.",
  },
  {
    table: "deliverables",
    column: "wa_message_id",
    definition: "wa_message_id VARCHAR(128) DEFAULT NULL",
    purpose: "The sent message's id, so delivery and read receipts can be matched back.",
  },
  {
    table: "deliverables",
    column: "wa_sent_at",
    definition: "wa_sent_at DATETIME DEFAULT NULL",
    purpose: "When the video went to WhatsApp.",
  },
  {
    table: "deliverables",
    column: "wa_delivered_at",
    definition: "wa_delivered_at DATETIME DEFAULT NULL",
    purpose: "When WhatsApp confirmed delivery to the client's device.",
  },
  {
    table: "deliverables",
    column: "wa_viewed_at",
    definition: "wa_viewed_at DATETIME DEFAULT NULL",
    purpose: "When the client read it — the Viewed step on their timeline.",
  },
  {
    table: "deliverables",
    column: "wa_responded_at",
    definition: "wa_responded_at DATETIME DEFAULT NULL",
    purpose: "When the client replied with a verdict.",
  },
  {
    table: "deliverables",
    column: "wa_approved_by",
    definition: "wa_approved_by VARCHAR(150) DEFAULT NULL",
    purpose: "The WhatsApp name of whoever approved it.",
  },
  {
    table: "deliverables",
    column: "wa_approved_phone",
    definition: "wa_approved_phone VARCHAR(40) DEFAULT NULL",
    purpose: "Their phone number, for the record.",
  },
  {
    table: "deliverables",
    column: "wa_comment",
    definition: "wa_comment TEXT DEFAULT NULL",
    purpose: "The change notes a client sent with CHANGE.",
  },
  {
    table: "deliverables",
    column: "wa_send_attempts",
    definition: "wa_send_attempts INT UNSIGNED NOT NULL DEFAULT 0",
    purpose: "How many times sending has been tried.",
  },
  {
    table: "deliverables",
    column: "wa_last_error",
    definition: "wa_last_error TEXT DEFAULT NULL",
    purpose: "Why the last send failed, shown on the task page.",
  },
  {
    table: "deliverables",
    column: "wa_approval_message_id",
    definition: "wa_approval_message_id VARCHAR(128) DEFAULT NULL",
    purpose: "Stops a redelivered WhatsApp reply approving the same video twice.",
  },
  {
    table: "video_analysis",
    column: "brand_seen",
    definition: "brand_seen TEXT DEFAULT NULL",
    purpose: "The logo, footer and contact details the AI read off the video.",
  },
  {
    table: "video_analysis",
    column: "context_used",
    definition: "context_used TEXT DEFAULT NULL",
    purpose: "The briefing about the business a caption was written from.",
  },
  {
    table: "video_analysis",
    column: "grounded",
    definition: "grounded TINYINT(1) NOT NULL DEFAULT 0",
    purpose: "Whether web search was on when the caption was written.",
  },
  {
    table: "video_analysis",
    column: "source_ref",
    definition: "source_ref VARCHAR(600) DEFAULT NULL",
    purpose: "Which video the caption describes, so replacing it can't leave the old one's caption behind.",
  },
  // The video_editor role. Three enums have to permit it: the one that decides
  // what a user can be, and the two that stamp who wrote a comment.
  {
    table: "users",
    column: "role",
    requiresEnumValue: "video_editor",
    definition:
      "ENUM('super_admin','admin','poster_designer','video_editor','crm','client') NOT NULL DEFAULT 'admin'",
    purpose: "Lets you create video editor accounts.",
  },
  {
    table: "feedback",
    column: "author_role",
    requiresEnumValue: "video_editor",
    definition:
      "ENUM('super_admin','admin','poster_designer','video_editor','crm','client') DEFAULT NULL",
    purpose: "So feedback from a video editor records who wrote it.",
  },
  {
    table: "task_comments",
    column: "author_role",
    requiresEnumValue: "video_editor",
    definition:
      "ENUM('super_admin','admin','poster_designer','video_editor','crm','client') DEFAULT NULL",
    purpose: "So a comment from a video editor records who wrote it.",
  },
  // The payment link an invoice reminder carries. Cached on the invoice so a
  // client chased three weeks running is sent the same link each time, rather
  // than three live links against one bill.
  {
    table: "invoices",
    column: "payment_link",
    definition: "payment_link VARCHAR(500) DEFAULT NULL",
    purpose: "The Razorpay link a WhatsApp invoice reminder carries.",
  },
  {
    table: "invoices",
    column: "payment_link_id",
    definition: "payment_link_id VARCHAR(64) DEFAULT NULL",
    purpose: "Razorpay's own id for that link, for matching a payment back to it.",
  },
  {
    table: "invoices",
    column: "payment_link_expires_at",
    definition: "payment_link_expires_at DATETIME DEFAULT NULL",
    purpose: "When the cached payment link stops working and a fresh one is made.",
  },
];

/**
 * Tables the analytics and publishing features need. Same rules as the
 * columns: literal statements, `IF NOT EXISTS`, nothing that can destroy data.
 * Written without foreign keys deliberately — `migrate.js` adds them, but a
 * hosted database where the parent tables live in a different engine or
 * charset would reject the constraint and leave the feature unusable. The
 * app's queries never depend on the FK, only on the columns.
 */
type TableSpec = { table: string; purpose: string; ddl: string };

const EXPECTED_TABLES: TableSpec[] = [
  {
    table: "client_month_plans",
    purpose:
      "What one client owes in one particular month — the video and poster counts and the amount. The client record holds one set of numbers for every month there will ever be, so a month that is agreed differently in advance had nowhere to live.",
    ddl: `CREATE TABLE IF NOT EXISTS client_month_plans (
      id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      client_id  BIGINT UNSIGNED NOT NULL,
      month_key  CHAR(7) NOT NULL,
      videos     INT NOT NULL DEFAULT 0,
      posters    INT NOT NULL DEFAULT 0,
      amount     DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      note       VARCHAR(500) DEFAULT NULL,
      /* The invoice this plan raised, so saving again never raises a second. */
      invoice_id BIGINT UNSIGNED DEFAULT NULL,
      created_by BIGINT UNSIGNED DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      /* One plan per client per month: a month is a decision, not a log. */
      UNIQUE KEY uniq_client_month (client_id, month_key),
      KEY idx_cmp_month (month_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "audience_snapshots",
    purpose:
      "One follower count per client, per platform, per day — so the ads page can show whether an account is growing rather than only what it has today.",
    ddl: `CREATE TABLE IF NOT EXISTS audience_snapshots (
      id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      client_id  BIGINT UNSIGNED NOT NULL,
      platform   VARCHAR(16) NOT NULL,
      followers  INT UNSIGNED NOT NULL,
      taken_on   DATE NOT NULL,
      PRIMARY KEY (id),
      /*
       * One row per client per platform per day, so writing on every page
       * view is harmless — the second read of the day updates the count
       * rather than adding a duplicate the month chart would then plot twice.
       */
      UNIQUE KEY uniq_audience_day (client_id, platform, taken_on),
      KEY idx_audience_client (client_id, platform, taken_on)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "post_insights",
    purpose:
      "How each published post actually performed — reach, likes, comments, saves and shares, read back from Instagram. What the Analytics board is built on.",
    /*
     * Word for word what `database/migrate.js` already creates.
     *
     * The table was in the schema before anything read from it, so the
     * Analytics board was written against the columns that were already there
     * rather than a second, near-identical table beside them. Any difference
     * between this and migrate.js is a bug in one of them.
     */
    ddl: `CREATE TABLE IF NOT EXISTS post_insights (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      deliverable_id BIGINT UNSIGNED DEFAULT NULL,
      client_id      BIGINT UNSIGNED NOT NULL,
      platform       VARCHAR(30) NOT NULL DEFAULT 'instagram',
      media_id       VARCHAR(64) NOT NULL,
      media_type     VARCHAR(30) DEFAULT NULL,
      permalink      VARCHAR(500) DEFAULT NULL,
      thumbnail_url  VARCHAR(700) DEFAULT NULL,
      caption        TEXT DEFAULT NULL,
      published_at   DATETIME DEFAULT NULL,
      snapshot_date  DATE NOT NULL,
      reach          BIGINT NOT NULL DEFAULT 0,
      impressions    BIGINT NOT NULL DEFAULT 0,
      views          BIGINT NOT NULL DEFAULT 0,
      plays          BIGINT NOT NULL DEFAULT 0,
      likes          BIGINT NOT NULL DEFAULT 0,
      comments       BIGINT NOT NULL DEFAULT 0,
      shares         BIGINT NOT NULL DEFAULT 0,
      saves          BIGINT NOT NULL DEFAULT 0,
      total_interactions BIGINT NOT NULL DEFAULT 0,
      engagement_rate DECIMAL(7,2) NOT NULL DEFAULT 0.00,
      raw_json       JSON DEFAULT NULL,
      created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      /* One row per post per day, so a re-read the same day corrects the
         figures and a read tomorrow records how the post has since grown. */
      UNIQUE KEY uq_post_insight (media_id, snapshot_date),
      KEY idx_pi_client_date (client_id, snapshot_date),
      KEY idx_pi_deliv (deliverable_id),
      KEY idx_pi_published (published_at),
      CONSTRAINT fk_pi_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
      CONSTRAINT fk_pi_deliv FOREIGN KEY (deliverable_id) REFERENCES deliverables(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "competitors",
    purpose:
      "The accounts a client is measured against. Public Instagram handles, read through Meta's business discovery — no scraping, and nothing a client could not see themselves.",
    ddl: `CREATE TABLE IF NOT EXISTS competitors (
      id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      client_id   BIGINT UNSIGNED NOT NULL,
      handle      VARCHAR(64) NOT NULL,
      label       VARCHAR(150) DEFAULT NULL,
      /* Last read from Meta, so a stale comparison can say it is stale. */
      followers   BIGINT UNSIGNED DEFAULT NULL,
      media_count BIGINT UNSIGNED DEFAULT NULL,
      /* Their recent posts as Meta returned them — kept whole so the gap
         analysis can be re-run without spending another API call. */
      snapshot_json JSON DEFAULT NULL,
      checked_at  DATETIME DEFAULT NULL,
      last_error  VARCHAR(400) DEFAULT NULL,
      added_by    BIGINT UNSIGNED DEFAULT NULL,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_competitor (client_id, handle),
      CONSTRAINT fk_comp_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "post_comments",
    purpose:
      "Comments on a client's own published posts, with what each one is — a question, a complaint, or somebody asking to buy. What the sentiment board reads.",
    ddl: `CREATE TABLE IF NOT EXISTS post_comments (
      id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      client_id  BIGINT UNSIGNED NOT NULL,
      media_id   VARCHAR(64) NOT NULL,
      comment_id VARCHAR(64) NOT NULL,
      username   VARCHAR(190) DEFAULT NULL,
      text       TEXT DEFAULT NULL,
      posted_at  DATETIME DEFAULT NULL,
      /* positive | neutral | negative | question | complaint | lead — null
         until it has been classified, so an unclassified comment is visibly
         unclassified rather than quietly filed as neutral. */
      sentiment  VARCHAR(16) DEFAULT NULL,
      /* A reply the agency could send, for a person to edit and use. */
      suggested_reply VARCHAR(600) DEFAULT NULL,
      handled    TINYINT(1) NOT NULL DEFAULT 0,
      fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_comment (comment_id),
      KEY idx_pc_client (client_id, posted_at),
      KEY idx_pc_sentiment (client_id, sentiment, handled),
      CONSTRAINT fk_pc_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "feedback_items",
    purpose:
      "A client's requested changes, split into separate jobs somebody can tick off. One round of revisions per task — what the client actually said stays on the task itself.",
    ddl: `CREATE TABLE IF NOT EXISTS feedback_items (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      deliverable_id BIGINT UNSIGNED NOT NULL,
      title          VARCHAR(200) NOT NULL,
      detail         VARCHAR(1000) DEFAULT NULL,
      /* Which kind of person does it. Null when it was not obvious — better
         unassigned than assigned to the wrong trade. */
      role           VARCHAR(32) DEFAULT NULL,
      is_done        TINYINT(1) NOT NULL DEFAULT 0,
      created_by     BIGINT UNSIGNED DEFAULT NULL,
      created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_fi_deliverable (deliverable_id, is_done),
      CONSTRAINT fk_fi_deliverable FOREIGN KEY (deliverable_id) REFERENCES deliverables(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "client_knowledge",
    purpose:
      "The part of a client's brand that lived in somebody's head — audience, tone, colours, the words they use, the words they never use, and their own calls to action. Every AI feature reads it before writing anything.",
    ddl: `CREATE TABLE IF NOT EXISTS client_knowledge (
      client_id      BIGINT UNSIGNED NOT NULL,
      audience       VARCHAR(500) DEFAULT NULL,
      tone           VARCHAR(300) DEFAULT NULL,
      brand_colors   VARCHAR(200) DEFAULT NULL,
      /* One item per line. Edited in a textarea by somebody thinking about
         the client, which is the shape a join table would not survive. */
      approved_terms TEXT DEFAULT NULL,
      banned_terms   TEXT DEFAULT NULL,
      restrictions   TEXT DEFAULT NULL,
      ctas           TEXT DEFAULT NULL,
      notes          TEXT DEFAULT NULL,
      updated_by     BIGINT UNSIGNED DEFAULT NULL,
      updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      /* One row per client, so a save is an upsert and there is exactly one
         answer to "what does this client sound like". */
      PRIMARY KEY (client_id),
      CONSTRAINT fk_ck_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "ai_insights",
    purpose:
      "What the Marketing Brain found for each client — one row per client per kind, so a finding that is still true is updated rather than duplicated, and one that has stopped being true is removed.",
    /* Word for word what `database/migrate.js` creates. */
    ddl: `CREATE TABLE IF NOT EXISTS ai_insights (
      id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      client_id    BIGINT UNSIGNED NOT NULL,
      platform     VARCHAR(30) NOT NULL DEFAULT 'instagram',
      kind         VARCHAR(40) NOT NULL,
      headline     VARCHAR(255) NOT NULL,
      detail       TEXT DEFAULT NULL,
      confidence   DECIMAL(4,2) NOT NULL DEFAULT 0.00,
      evidence_json JSON DEFAULT NULL,
      period_start DATE DEFAULT NULL,
      period_end   DATE DEFAULT NULL,
      generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_ai_insight (client_id, platform, kind),
      KEY idx_ai_client (client_id),
      CONSTRAINT fk_ai_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "scheduled_reports",
    purpose:
      "One row per client per month of the automatic report — what was generated and whether it reached them. Its unique key is what stops the job on the 1st sending everybody two copies.",
    /* Word for word what `database/migrate.js` creates. */
    ddl: `CREATE TABLE IF NOT EXISTS scheduled_reports (
      id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      client_id    BIGINT UNSIGNED NOT NULL,
      period       ENUM('weekly','monthly') NOT NULL,
      period_start DATE NOT NULL,
      period_end   DATE NOT NULL,
      status       ENUM('pending','sent','failed') NOT NULL DEFAULT 'pending',
      sent_to      VARCHAR(190) DEFAULT NULL,
      error_message TEXT DEFAULT NULL,
      summary_json JSON DEFAULT NULL,
      sent_at      DATETIME DEFAULT NULL,
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_report_period (client_id, period, period_start),
      KEY idx_sr_client (client_id),
      CONSTRAINT fk_sr_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "leads",
    purpose:
      "Enquiries on their way to becoming clients — the pipeline the Leads board reads, from first contact to won or lost.",
    ddl: `CREATE TABLE IF NOT EXISTS leads (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      name           VARCHAR(150) NOT NULL,
      company        VARCHAR(190) DEFAULT NULL,
      phone          VARCHAR(32) DEFAULT NULL,
      email          VARCHAR(190) DEFAULT NULL,
      source         VARCHAR(32) NOT NULL DEFAULT 'manual',
      stage          VARCHAR(16) NOT NULL DEFAULT 'new',
      value          DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      owner_user_id  BIGINT UNSIGNED DEFAULT NULL,
      next_follow_up DATE DEFAULT NULL,
      note           TEXT DEFAULT NULL,
      lost_reason    VARCHAR(190) DEFAULT NULL,
      /* Set when the lead is won and becomes a client, so the pipeline can
         point at what it produced instead of losing the thread there. */
      client_id      BIGINT UNSIGNED DEFAULT NULL,
      created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_lead_stage (stage),
      KEY idx_lead_follow (next_follow_up),
      KEY idx_lead_owner (owner_user_id),
      CONSTRAINT fk_lead_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "expenses",
    purpose:
      "What the agency spends — salaries, subscriptions, ad budgets, rent — with the recurring ones due again on a date.",
    ddl: `CREATE TABLE IF NOT EXISTS expenses (
      id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      title        VARCHAR(200) NOT NULL,
      category     VARCHAR(40) NOT NULL DEFAULT 'other',
      amount       DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      currency     CHAR(3) NOT NULL DEFAULT 'INR',
      vendor       VARCHAR(150) DEFAULT NULL,
      due_on       DATE NOT NULL,
      paid_on      DATE DEFAULT NULL,
      repeats      VARCHAR(12) NOT NULL DEFAULT 'once',
      remind       TINYINT(1) NOT NULL DEFAULT 1,
      remind_days  INT UNSIGNED NOT NULL DEFAULT 3,
      client_id    BIGINT UNSIGNED DEFAULT NULL,
      note         TEXT DEFAULT NULL,
      created_by   BIGINT UNSIGNED DEFAULT NULL,
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_exp_due (due_on),
      KEY idx_exp_paid (paid_on),
      KEY idx_exp_category (category),
      KEY idx_exp_client (client_id),
      CONSTRAINT fk_exp_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "ad_insights",
    purpose:
      "One row per client per day of Meta ad spend, impressions and leads — what the Ad management board reads.",
    ddl: `CREATE TABLE IF NOT EXISTS ad_insights (
      id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      client_id   BIGINT UNSIGNED NOT NULL,
      date        DATE NOT NULL,
      spend       DECIMAL(14,2) NOT NULL DEFAULT 0,
      currency    VARCHAR(8) NOT NULL DEFAULT 'INR',
      impressions BIGINT UNSIGNED NOT NULL DEFAULT 0,
      reach       BIGINT UNSIGNED NOT NULL DEFAULT 0,
      clicks      BIGINT UNSIGNED NOT NULL DEFAULT 0,
      leads       INT UNSIGNED NOT NULL DEFAULT 0,
      link_clicks    INT NULL,
      video_views    INT NULL,
      profile_visits INT NULL,
      synced_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      -- The upsert key. One row per client per day is what lets a re-sync
      -- correct a figure Meta has restated instead of adding a second copy.
      UNIQUE KEY uniq_client_day (client_id, date),
      KEY idx_date (date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "ad_performance",
    purpose:
      "One row per ad per day — which individual ad is working and which is burning money. " +
      "`ad_insights` only ever held the account's daily total, so nothing could name an ad.",
    ddl: `CREATE TABLE IF NOT EXISTS ad_performance (
      id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      client_id     BIGINT UNSIGNED NOT NULL,
      ad_id         VARCHAR(40) NOT NULL,
      date          DATE NOT NULL,
      ad_name       VARCHAR(255) DEFAULT NULL,
      campaign_name VARCHAR(255) DEFAULT NULL,
      spend         DECIMAL(14,2) NOT NULL DEFAULT 0,
      currency      VARCHAR(8) NOT NULL DEFAULT 'INR',
      impressions   BIGINT UNSIGNED NOT NULL DEFAULT 0,
      reach         BIGINT UNSIGNED NOT NULL DEFAULT 0,
      clicks        BIGINT UNSIGNED NOT NULL DEFAULT 0,
      leads         INT UNSIGNED NOT NULL DEFAULT 0,
      link_clicks    INT NULL,
      video_views    INT NULL,
      profile_visits INT NULL,
      adset_id      VARCHAR(40) DEFAULT NULL,
      locations     VARCHAR(500) DEFAULT NULL,
      synced_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      -- Same reason as ad_insights: Meta restates figures as attribution
      -- settles, so a re-sync must correct a row rather than add a second.
      UNIQUE KEY uniq_ad_day (ad_id, date),
      KEY idx_ap_client_date (client_id, date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "publish_attempts",
    purpose: "Audit trail of every Instagram publish attempt, including failures.",
    ddl: `CREATE TABLE IF NOT EXISTS publish_attempts (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      deliverable_id BIGINT UNSIGNED NOT NULL,
      client_id      BIGINT UNSIGNED DEFAULT NULL,
      platform       VARCHAR(30) NOT NULL DEFAULT 'instagram',
      attempt_no     INT UNSIGNED NOT NULL DEFAULT 1,
      stage          VARCHAR(40) NOT NULL DEFAULT 'claimed',
      status         ENUM('processing','posted','failed','skipped') NOT NULL DEFAULT 'processing',
      container_id   VARCHAR(64) DEFAULT NULL,
      media_id       VARCHAR(64) DEFAULT NULL,
      permalink      VARCHAR(500) DEFAULT NULL,
      error_code     VARCHAR(60) DEFAULT NULL,
      error_message  TEXT DEFAULT NULL,
      duration_ms    INT UNSIGNED DEFAULT NULL,
      run_id         VARCHAR(80) DEFAULT NULL,
      created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_pa_deliv (deliverable_id),
      KEY idx_pa_client (client_id),
      KEY idx_pa_created (created_at),
      KEY idx_pa_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "whatsapp_groups",
    purpose:
      "Which WhatsApp group belongs to which client, and what each group is for.",
    ddl: `CREATE TABLE IF NOT EXISTS whatsapp_groups (
      id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      client_id   BIGINT UNSIGNED NOT NULL,
      group_id    VARCHAR(64) NOT NULL,
      group_name  VARCHAR(190) DEFAULT NULL,
      is_default  TINYINT(1) NOT NULL DEFAULT 1,
      is_active   TINYINT(1) NOT NULL DEFAULT 1,
      for_approvals TINYINT(1) NOT NULL DEFAULT 1,
      for_footage   TINYINT(1) NOT NULL DEFAULT 1,
      for_payments  TINYINT(1) NOT NULL DEFAULT 1,
      for_updates   TINYINT(1) NOT NULL DEFAULT 1,
      for_chat      TINYINT(1) NOT NULL DEFAULT 1,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_wa_group (group_id),
      KEY idx_wag_client (client_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "whatsapp_messages",
    purpose: "Every message from a client group — the record when an approval is disputed.",
    ddl: `CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      wa_message_id  VARCHAR(128) DEFAULT NULL,
      group_id       VARCHAR(64) NOT NULL,
      group_name     VARCHAR(190) DEFAULT NULL,
      client_id      BIGINT UNSIGNED DEFAULT NULL,
      deliverable_id BIGINT UNSIGNED DEFAULT NULL,
      video_code     VARCHAR(20) DEFAULT NULL,
      sender_name    VARCHAR(150) DEFAULT NULL,
      sender_number  VARCHAR(40) DEFAULT NULL,
      direction      ENUM('in','out') NOT NULL DEFAULT 'in',
      message        TEXT DEFAULT NULL,
      parsed_command VARCHAR(24) DEFAULT NULL,
      message_time   DATETIME NOT NULL,
      created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_wa_msg (wa_message_id),
      KEY idx_wam_group (group_id),
      KEY idx_wam_deliv (deliverable_id),
      KEY idx_wam_time (message_time)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "whatsapp_send_log",
    purpose: "Every send attempt, retry and delivery receipt for approval videos.",
    ddl: `CREATE TABLE IF NOT EXISTS whatsapp_send_log (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      deliverable_id BIGINT UNSIGNED DEFAULT NULL,
      video_code     VARCHAR(20) DEFAULT NULL,
      group_id       VARCHAR(64) DEFAULT NULL,
      attempt_no     INT UNSIGNED NOT NULL DEFAULT 1,
      status         ENUM('queued','sending','sent','delivered','read','failed') NOT NULL DEFAULT 'queued',
      wa_message_id  VARCHAR(128) DEFAULT NULL,
      media_bytes    BIGINT UNSIGNED DEFAULT NULL,
      duration_ms    INT UNSIGNED DEFAULT NULL,
      error_code     VARCHAR(60) DEFAULT NULL,
      error_message  TEXT DEFAULT NULL,
      created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_wsl_deliv (deliverable_id),
      KEY idx_wsl_status (status),
      KEY idx_wsl_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "video_analysis",
    purpose: "What the AI saw in each video and the caption it wrote from it.",
    ddl: `CREATE TABLE IF NOT EXISTS video_analysis (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      deliverable_id BIGINT UNSIGNED NOT NULL,
      state          VARCHAR(24) NOT NULL DEFAULT 'queued',
      file_uri       VARCHAR(500) DEFAULT NULL,
      file_name      VARCHAR(255) DEFAULT NULL,
      file_expires_at DATETIME DEFAULT NULL,
      source_ref     VARCHAR(600) DEFAULT NULL,
      model          VARCHAR(60) DEFAULT NULL,
      summary        TEXT DEFAULT NULL,
      spoken_language VARCHAR(40) DEFAULT NULL,
      topic          VARCHAR(190) DEFAULT NULL,
      mood           VARCHAR(60) DEFAULT NULL,
      on_screen_text TEXT DEFAULT NULL,
      scenes_json    JSON DEFAULT NULL,
      caption        TEXT DEFAULT NULL,
      hook           TEXT DEFAULT NULL,
      hashtags       TEXT DEFAULT NULL,
      brand_seen     TEXT DEFAULT NULL,
      context_used   TEXT DEFAULT NULL,
      grounded       TINYINT(1) NOT NULL DEFAULT 0,
      raw_json       JSON DEFAULT NULL,
      video_bytes    BIGINT UNSIGNED DEFAULT NULL,
      tokens_used    INT UNSIGNED DEFAULT NULL,
      duration_ms    INT UNSIGNED DEFAULT NULL,
      attempts       INT UNSIGNED NOT NULL DEFAULT 0,
      last_error     TEXT DEFAULT NULL,
      locked_at      DATETIME DEFAULT NULL,
      created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_va_deliv (deliverable_id),
      KEY idx_va_state (state)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "client_fingerprints",
    purpose: "Logo and watermark cues confirmed for a client, used when writing captions.",
    ddl: `CREATE TABLE IF NOT EXISTS client_fingerprints (
      id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      client_id  BIGINT UNSIGNED NOT NULL,
      cue_type   ENUM('logo','watermark','brand_text') NOT NULL DEFAULT 'brand_text',
      cue_value  VARCHAR(500) NOT NULL,
      created_by BIGINT UNSIGNED DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_fp_client (client_id),
      KEY idx_fp_value (cue_value)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "whatsapp_reminders",
    purpose:
      "One row per reminder sent. The unique key is what stops a client being nudged twice.",
    ddl: `CREATE TABLE IF NOT EXISTS whatsapp_reminders (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      kind           VARCHAR(32) NOT NULL,
      scope_key      VARCHAR(96) NOT NULL,
      client_id      BIGINT UNSIGNED DEFAULT NULL,
      deliverable_id BIGINT UNSIGNED DEFAULT NULL,
      group_id       VARCHAR(64) DEFAULT NULL,
      sent_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_wr_once (kind, scope_key),
      KEY idx_wr_client (client_id),
      KEY idx_wr_sent (sent_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "automation_runs",
    purpose:
      "When each scheduled job last ran — how the portal can say whether the automatic reminders are firing.",
    ddl: `CREATE TABLE IF NOT EXISTS automation_runs (
      job      VARCHAR(40) NOT NULL,
      ran_at   DATETIME NOT NULL,
      ok       TINYINT(1) NOT NULL DEFAULT 1,
      summary  VARCHAR(500) DEFAULT NULL,
      PRIMARY KEY (job)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "whatsapp_outbox",
    purpose:
      "Reminders written now and sent later, with the wording frozen as it was approved.",
    ddl: `CREATE TABLE IF NOT EXISTS whatsapp_outbox (
      id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      kind            VARCHAR(32) NOT NULL DEFAULT 'custom',
      client_id       BIGINT UNSIGNED DEFAULT NULL,
      group_id        VARCHAR(64) NOT NULL,
      group_label     VARCHAR(190) DEFAULT NULL,
      body            TEXT NOT NULL,
      send_at         DATETIME NOT NULL,
      status          ENUM('scheduled','sending','sent','failed','cancelled') NOT NULL DEFAULT 'scheduled',
      attempts        INT UNSIGNED NOT NULL DEFAULT 0,
      last_error      TEXT DEFAULT NULL,
      wa_message_id   VARCHAR(128) DEFAULT NULL,
      created_by      BIGINT UNSIGNED DEFAULT NULL,
      created_by_name VARCHAR(150) DEFAULT NULL,
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      claimed_at      DATETIME DEFAULT NULL,
      sent_at         DATETIME DEFAULT NULL,
      PRIMARY KEY (id),
      KEY idx_wo_due (status, send_at),
      KEY idx_wo_client (client_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
  {
    table: "whatsapp_session",
    purpose: "Connection health of the WhatsApp account, shown on the settings page.",
    ddl: `CREATE TABLE IF NOT EXISTS whatsapp_session (
      id             TINYINT UNSIGNED NOT NULL DEFAULT 1,
      state          VARCHAR(32) NOT NULL DEFAULT 'disconnected',
      phone_number   VARCHAR(40) DEFAULT NULL,
      push_name      VARCHAR(150) DEFAULT NULL,
      qr_available   TINYINT(1) NOT NULL DEFAULT 0,
      last_ready_at  DATETIME DEFAULT NULL,
      last_error     TEXT DEFAULT NULL,
      heartbeat_at   DATETIME DEFAULT NULL,
      updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
];

export type SchemaColumnStatus = ColumnSpec & { present: boolean };
export type SchemaTableStatus = { table: string; purpose: string; present: boolean };

/**
 * One information_schema round trip for the whole list.
 *
 * The columns are aliased and lowercased in SQL rather than in JS: MySQL
 * returns information_schema names in upper case, so reading `row.table_name`
 * gives undefined and every column looks missing — which then tries to add
 * columns that are already there.
 */
export async function schemaStatus(): Promise<SchemaColumnStatus[]> {
  // The tables to inspect come from EXPECTED itself, so adding a spec for a
  // new table above is all that's needed — no second list to keep in step.
  const tables = [...new Set(EXPECTED.map((c) => c.table.toLowerCase()))];
  const rows = await query<{ t: string; c: string; ty: string }>(
    `SELECT LOWER(TABLE_NAME) AS t, LOWER(COLUMN_NAME) AS c, COLUMN_TYPE AS ty
       FROM information_schema.columns
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN (${tables.map(() => "?").join(",")})`,
    tables
  );
  const types = new Map(rows.map((r) => [`${r.t}.${r.c}`, String(r.ty)]));

  return EXPECTED.map((c) => {
    const key = `${c.table}.${c.column}`.toLowerCase();
    const type = types.get(key);
    return {
      ...c,
      // An enum spec is satisfied by the value being permitted, not by the
      // column merely existing — it always exists.
      present: c.requiresEnumValue
        ? Boolean(type?.includes(`'${c.requiresEnumValue}'`))
        : types.has(key),
    };
  });
}

/** The values an existing ENUM column currently permits. */
function enumValues(columnType: string): string[] {
  return [...columnType.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
}

/** Which of the analytics/publishing tables already exist. */
export async function tableStatus(): Promise<SchemaTableStatus[]> {
  const names = EXPECTED_TABLES.map((t) => t.table);
  const rows = await query<{ t: string }>(
    `SELECT LOWER(TABLE_NAME) AS t FROM information_schema.tables
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${names.map(() => "?").join(",")})`,
    names
  );
  const have = new Set(rows.map((r) => r.t));
  return EXPECTED_TABLES.map(({ table, purpose }) => ({
    table,
    purpose,
    present: have.has(table.toLowerCase()),
  }));
}

export type ApplyResult = {
  added: string[];
  failed: { column: string; error: string }[];
};

/**
 * Add whatever is missing. Each statement is attempted on its own so one
 * failure doesn't strand the rest, and `hasColumn`'s cache is cleared for
 * anything added — otherwise this process would keep believing the column is
 * absent until it restarts.
 *
 * Tables are created before columns: a spec may add a column to a table this
 * same run is responsible for creating.
 */
export async function applyPendingColumns(): Promise<ApplyResult> {
  const added: string[] = [];
  const failed: { column: string; error: string }[] = [];

  // Checked first rather than relying on IF NOT EXISTS alone, so the result
  // reports what this run actually created instead of listing every table.
  const missingTables = new Set((await tableStatus()).filter((t) => !t.present).map((t) => t.table));
  for (const t of EXPECTED_TABLES) {
    if (!missingTables.has(t.table)) continue;
    try {
      // `ddl` is a literal from the list above, never from input.
      await executeDdl(t.ddl);
      added.push(`${t.table} (table)`);
    } catch (e) {
      failed.push({
        column: `${t.table} (table)`,
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }

  for (const c of await schemaStatus()) {
    if (c.present) continue;
    try {
      if (c.requiresEnumValue) {
        /*
         * Widening an enum is the one statement here that touches something
         * that already exists, so it is checked before it runs: MySQL turns a
         * value dropped from an enum into an empty string on every row using
         * it, silently. Refusing beats explaining afterwards.
         */
        const row = await query<{ ty: string }>(
          `SELECT COLUMN_TYPE AS ty FROM information_schema.columns
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
          [c.table, c.column]
        );
        const current = enumValues(row[0]?.ty || "");
        const lost = current.filter((v) => !c.definition.includes(`'${v}'`));
        if (lost.length) {
          throw new Error(
            `would drop existing value(s) ${lost.join(", ")} — not applied`
          );
        }
        await executeDdl(`ALTER TABLE \`${c.table}\` MODIFY COLUMN \`${c.column}\` ${c.definition}`);
        added.push(`${c.table}.${c.column} (+${c.requiresEnumValue})`);
        continue;
      }

      // `definition` is a literal from the list above, never from input.
      await executeDdl(`ALTER TABLE \`${c.table}\` ADD COLUMN ${c.definition}`);
      forgetColumn(c.table, c.column);
      added.push(`${c.table}.${c.column}`);
    } catch (e) {
      failed.push({
        column: `${c.table}.${c.column}`,
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }
  return { added, failed };
}
