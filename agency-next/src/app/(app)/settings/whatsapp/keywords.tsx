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
        reply: "✅ Thank you! Approved — _title_\nWe'll get it scheduled for posting.",
        note: "Only when the whole message is just that word. “ok but change the music” is a change request, not an approval.",
      },
      {
        types: ["APPROVE V245", "approve v245", "approve #V245", "approve V-245"],
        does: "Approves that exact video. Needed when more than one is waiting.",
        reply: "✅ Thank you! *V245* Approved — _title_\nWe'll get it scheduled for posting.",
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
        reply:
          "📝 Thank you — noted — _title_\nYour changes have gone to the editor, and we'll share the updated version here soon.",
        note: "Everything after the keyword becomes the editor's note. A voice note works too — it is transcribed first.",
      },
      {
        types: ["approved, but change the ending"],
        does: "Treated as a change, not an approval.",
        reply:
          "📝 Thank you — noted — _title_\nYour changes have gone to the editor, and we'll share the updated version here soon.",
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
        reply:
          "🚫 Understood — _title_\nWe've marked it as rejected. Someone from our team will follow up with you shortly.",
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
        reply: "🙏 Thank you! We've received it and attached it to *title* — our team will start editing.",
        note: "Known file hosts only: Drive, Docs, Google Photos, Dropbox, WeTransfer, iCloud, OneDrive, MEGA, Frame.io, Box, Terabox, Send Anywhere, pCloud.",
      },
      {
        types: ["raw <any link>", "footage <link>", "shoot <link>", "clips <link>", "files <link>"],
        does: "Same, for a host not on the list above.",
        reply: "🙏 Thank you! We've received it and attached it to *title* — our team will start editing.",
        note: "The word is what makes an unknown link count as footage — so an article or a competitor's reel dropped in the chat stays just a link.",
      },
    ],
  },
];

/**
 * Anything else they type — the part with no keyword at all.
 *
 * The rows above are commands: fixed words, a fixed reply. This is the
 * assistant, which reads the client's own record and answers in their words.
 * Worth writing down separately because the two behave differently in the one
 * way that matters to whoever is watching the group: a command always answers
 * the same, and this answers from the facts as they are that minute.
 *
 * The examples are real replies, taken from the model against a test client —
 * not invented for the page. What they show is the *shape* of an answer, not
 * wording to expect back verbatim.
 */
const ASKED: { q: string; a: string; note?: string }[] = [
  {
    q: "when is my next video going out?",
    a: 'Hi Ravi! Your next video, V101 "Diwali reel", is scheduled to go out on August 14 at 5:00 PM.\n\nIt is currently awaiting your review. Whenever you have a moment, could you please send APPROVE V101 if it looks good, or CHANGE V101 with your notes? 😊',
    note: "Times are converted to Indian time first — the database keeps them in UTC.",
  },
  {
    q: "how many videos do i get this month and how many are done",
    a: 'Your package includes 8 videos for this month.\n\nSo far, 1 video has been posted (V103 "Client testimonial"). We also have V101 "Diwali reel" awaiting your review, V102 "Studio walkthrough" in editing, and we\'re waiting for raw footage for V104 "Founder story" whenever you have a moment. 😊',
  },
  {
    q: "what do i owe you",
    a: "Hi Ravi, you currently have one open invoice, INV-14, for ₹25,000 which was due on 5 August 2026.\n\nWhenever you have a moment, you can complete the payment using this link: https://rzp.io/x. Thank you! 😊",
    note: "Their own invoice only, and only a payment link that already exists.",
  },
  {
    q: "and the other one?",
    a: 'V102 "Studio walkthrough" is currently being edited and is due on 16 August.',
    note: "It reads the last ten messages, so a follow-up does not need repeating.",
  },
  {
    q: "why is everything so slow, this is the third time im asking",
    a: "Thank you for letting us know, Ravi, and I am so sorry for the delay you have experienced.\n\nCould you please give me a moment while I check with the team on this right away, and someone will come back to you shortly? 🙏",
    note: "It never argues and never explains why they are wrong — it escalates.",
  },
  {
    q: "meeru website design kuda chestara?",
    a: "Namaste Ravi garu! 🙏 Website design vishayam lo ma team tho oka sari matladi, evaru aina mimmalni contact avvamanatam jarugutundi, please konchem time ivvandi.",
    note: "It answers in whatever language they wrote in — English, Telugu, Hindi or a mix.",
  },
  {
    q: "next month ki 20 videos ki entha avthundi?",
    a: "Thank you so much for asking about upgrading your package, Ravi.\n\nCould you please give us a moment to check on the pricing for 20 videos next month? I'll have someone from the team get back to you shortly with the details. 😊",
    note: "It will never quote a price. Money it has not been given is always the team's to confirm.",
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

        {/* No keyword at all. Set apart from the rows above because it does
            not behave like them: a command has one fixed reply, this reads the
            client's record and answers in their words. */}
        <section className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
          <div>
            <h3 className="text-sm font-medium">Anything else they ask</h3>
            <p className="text-xs text-muted-foreground">
              No keyword needed. The assistant answers from that client&apos;s own record —
              their videos and dates, their monthly package, what we&apos;re waiting on from
              them, and their unpaid invoices. It never quotes a price it wasn&apos;t given,
              and anything it can&apos;t answer goes to the team with the client told someone
              will come back to them. Real replies, so the shape is right — the wording
              varies.
            </p>
          </div>
          <ul className="space-y-2">
            {ASKED.map((x) => (
              <li key={x.q} className="rounded-lg border border-border bg-card p-3">
                <p className="text-xs font-medium">
                  <span className="text-muted-foreground">They type </span>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{x.q}</code>
                </p>
                <pre className="mt-2 whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-2.5 font-mono text-xs leading-relaxed">
                  {x.a}
                </pre>
                {x.note ? (
                  <p className="mt-2 text-xs italic text-muted-foreground">{x.note}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>

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
