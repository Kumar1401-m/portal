import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MessageSquareText } from "lucide-react";

/**
 * What a client can type in their group, and what comes back.
 *
 * Written down here because nobody could see it anywhere. The parser is
 * deliberately forgiving — clients type on phones, not to a syntax — and the
 * result was a set of behaviours only the source could describe. A team member
 * asked what to tell a client and the honest answer was "read the regex".
 *
 * KEPT IN STEP BY HAND, and that is the risk worth naming: the parser lives in
 * `whatsapp-service/src/lib/command-parser.js`, a separate Node service the
 * portal cannot import. Every example below is pinned by a test in
 * `command-parser.test.js` under the heading "documented on the WhatsApp
 * settings page", so changing the parser without changing this page fails that
 * test. Add a row here, add the case there.
 */

type Keyword = {
  /** What they type. The first is the canonical form. */
  types: string[];
  does: string;
  /** The exact reply, or null when the portal deliberately says nothing. */
  reply: string | null;
  note?: string;
};

const GROUPS: { heading: string; blurb: string; rows: Keyword[] }[] = [
  {
    heading: "Approving a video",
    blurb:
      "Any of these approve it. With one video waiting, no code is needed — a bare OK is enough.",
    rows: [
      {
        types: ["OK", "okay", "yes", "yep", "sure", "done", "fine", "👍", "✅"],
        does: "Approves the one video waiting in that group.",
        reply: "✅ Approved — _title_\nThank you! We'll schedule it for posting.",
        note: "Only when the whole message is just that word. “ok but change the music” is a change request, not an approval.",
      },
      {
        types: ["APPROVE V245", "approve v245", "approve #V245", "approve V-245"],
        does: "Approves that exact video. Needed when more than one is waiting.",
        reply: "✅ *V245* Approved — _title_\nThank you! We'll schedule it for posting.",
      },
    ],
  },
  {
    heading: "Asking for a change",
    blurb: "Checked before approval, so a message that does both counts as a change.",
    rows: [
      {
        types: [
          "change make the subtitles bigger",
          "revise …",
          "edit …",
          "modify …",
          "redo …",
        ],
        does: "Sends the note to the editor and reopens the video.",
        reply: "📝 Noted — _title_\nYour changes have gone to the editor.",
        note: "Everything after the keyword becomes the editor's note. A voice note works too — it is transcribed first.",
      },
      {
        types: ["approved, but change the ending"],
        does: "Treated as a change, not an approval.",
        reply: "📝 Noted — _title_\nYour changes have gone to the editor.",
        note: "Deliberate: reading this as approval would publish work the client just objected to.",
      },
    ],
  },
  {
    heading: "Rejecting",
    blurb: "Only when the message does not also mention a change.",
    rows: [
      {
        types: ["reject", "cancel", "discard", "drop"],
        does: "Marks it rejected.",
        reply: "🚫 *V245* Marked as rejected — _title_\nWe'll follow up with you.",
      },
    ],
  },
  {
    heading: "Asking where things stand",
    blurb: "The whole message must be just this word — otherwise it stays a conversation.",
    rows: [
      {
        types: ["status", "update", "progress"],
        does: "Replies with this month's counts and what is next.",
        reply:
          "*This month so far*\n✅ 4 posted\n👀 1 waiting for your approval\n📤 2 waiting on footage from you\n\nNext up: *Diwali reel* on 14 Aug 2026.\n\nReply *OK* to approve, or *change* with what you'd like different.",
        note: "Only on its own. “what's the status of the reel?” is a real question and gets no canned reply.",
      },
    ],
  },
  {
    heading: "Sending footage",
    blurb:
      "Anyone in the group can send it — a videographer or a manager as often as the client.",
    rows: [
      {
        types: ["a Drive / WeTransfer / Dropbox link, on its own"],
        does: "Attaches it to the oldest task still waiting on footage.",
        reply: "Got it — thanks! Attached to *title* and the team can start editing.",
        note: "Known file hosts only: Drive, Docs, Google Photos, Dropbox, WeTransfer, iCloud, OneDrive, MEGA, Frame.io, Box, Terabox, Send Anywhere, pCloud.",
      },
      {
        types: ["raw <any link>", "footage <link>", "shoot <link>", "clips <link>", "files <link>"],
        does: "Same, for a host not on the list above.",
        reply: "Got it — thanks! Attached to *title* and the team can start editing.",
        note: "The word is what makes an unknown link count as footage — so an article or a competitor's reel dropped in the chat stays just a link.",
      },
    ],
  },
];

/**
 * Words that set something off without anyone meaning to.
 *
 * Real behaviour, not a warning about a hypothetical. "change" is matched
 * anywhere in a message rather than only at the start, because clients write
 * the note before the command as often as after it — and the cost is that a
 * sentence merely mentioning the word is read as a change request.
 *
 * That is the parser failing safe: a false change reopens a video and someone
 * notices, where a false approval publishes it. Worth knowing all the same,
 * since the person who has to notice is on this team.
 */
const ACCIDENTAL: { phrase: string; becomes: string }[] = [
  {
    phrase: "we need to change our meeting time",
    becomes: "a change request on whichever video is waiting — the word is matched anywhere.",
  },
  {
    phrase: "what's the status of the music change?",
    becomes: "a change request too, not a status report. The word “change” wins.",
  },
];

/** Cases the portal answers with silence, and why that is the right answer. */
const SILENT: { when: string; why: string }[] = [
  {
    when: "Ordinary conversation",
    why: "Most of a client group is chatter. It is all saved to the transcript; nothing is replied to.",
  },
  {
    when: "A link when nothing is waiting on footage",
    why: "A bot announcing “received!” over a link to a news article is worse than silence.",
  },
  {
    when: "The portal is unreachable",
    why: "An outage is ours, not the client's. The message is still in WhatsApp for someone to pick up.",
  },
];

export function KeywordGuide() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageSquareText className="h-5 w-5 text-primary" /> What clients can type
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Case doesn&apos;t matter, and neither does punctuation. Clients never see a video code
          unless two videos are waiting at once — then the reply asks for one.
        </p>
      </CardHeader>

      <CardContent className="space-y-5">
        {GROUPS.map((g) => (
          <section key={g.heading} className="space-y-2">
            <div>
              <h3 className="text-sm font-medium">{g.heading}</h3>
              <p className="text-xs text-muted-foreground">{g.blurb}</p>
            </div>

            <ul className="space-y-2">
              {g.rows.map((r) => (
                <li key={r.types[0]} className="rounded-lg border border-border p-3">
                  <p className="flex flex-wrap gap-1.5">
                    {r.types.map((t) => (
                      <code
                        key={t}
                        className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground"
                      >
                        {t}
                      </code>
                    ))}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">{r.does}</p>
                  {r.reply ? (
                    <>
                      <p className="mt-2 text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground">
                        They get back
                      </p>
                      <pre className="mt-1 whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-2.5 font-mono text-xs leading-relaxed">
                        {r.reply}
                      </pre>
                    </>
                  ) : null}
                  {r.note ? (
                    <p className="mt-2 text-xs italic text-muted-foreground">{r.note}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))}

        <section className="space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3">
          <div>
            <h3 className="text-sm font-medium">Set off by accident</h3>
            <p className="text-xs text-muted-foreground">
              <b>change</b> is matched anywhere in a message, not just at the start — clients
              write the note before the command as often as after it. So a sentence that merely
              mentions the word counts:
            </p>
          </div>
          <ul className="space-y-1.5">
            {ACCIDENTAL.map((a) => (
              <li key={a.phrase} className="text-xs">
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{a.phrase}</code>
                <span className="text-muted-foreground"> → {a.becomes}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            It fails on the safe side: a change reopens a video and somebody notices, where a
            wrong approval publishes it. The other verbs — <b>approve</b>, <b>revise</b>,{" "}
            <b>edit</b>, <b>reject</b>, <b>cancel</b> — only count at the start of a message, so
            they don&apos;t do this.
          </p>
        </section>

        {/* Silence is a design decision here, not a gap — worth saying so, or
            someone will "fix" it by making the bot reply to everything. */}
        <section className="space-y-2">
          <div>
            <h3 className="text-sm font-medium">When it says nothing at all</h3>
            <p className="text-xs text-muted-foreground">
              Deliberate. A bot that answers everything trains people to ignore it.
            </p>
          </div>
          <ul className="space-y-1.5">
            {SILENT.map((s) => (
              <li key={s.when} className="text-xs">
                <span className="font-medium">{s.when}</span>{" "}
                <span className="text-muted-foreground">— {s.why}</span>
              </li>
            ))}
          </ul>
        </section>

        <p className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Two videos waiting at once</span> is the
          one case that can&apos;t be settled automatically. A bare <code>OK</code> then gets:
          &ldquo;More than one video is waiting here, so I can&apos;t tell which you mean. Please
          reply with the code, for example APPROVE V245.&rdquo;
        </p>
      </CardContent>
    </Card>
  );
}
