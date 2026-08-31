"use server";

import { revalidatePath } from "next/cache";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { canAccessClient } from "@/lib/crm";
import {
  generateMonthTasks,
  shiftMonthDates,
  safeMonth,
  removeTasks,
  respaceMonth,
} from "@/lib/task-plan";
import { fmtDate, money as fmtMoney } from "@/lib/utils";
import { monthRangeLabel } from "@/lib/date-range";
import { saveMonthPlan, clearMonthPlan, monthPlanFor, claimMonthInvoice } from "@/lib/month-plans";
import { raiseInvoice } from "@/lib/invoicing";

export type PlanState = {
  ok?: boolean;
  error?: string;
  message?: string;
  /**
   * Some tasks were left only because work had started on them.
   *
   * Distinct from a plain failure: it means the override would work, so the
   * panel can offer it. Nothing else should — a removal that found nothing
   * there must not invite someone to try harder.
   */
  blockedOnly?: boolean;
};

/**
 * Every action here takes the client id from the form, so each one re-checks
 * it. A crm may only touch their own clients, and the page having rendered is
 * not proof of that — the form can be replayed against any id.
 */
async function guard(formData: FormData) {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const clientId = Math.trunc(Number(formData.get("client_id")));
  if (!clientId || !(await canAccessClient(user, clientId))) return null;
  return { user, clientId };
}

const refresh = (clientId: number) => {
  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/deliverables");
  revalidatePath("/dashboard");
  revalidatePath("/today");
};

/** Fill the month up to the client's monthly targets. */
export async function generateMonthAction(
  _prev: PlanState,
  formData: FormData
): Promise<PlanState> {
  const ok = await guard(formData);
  if (!ok) return { error: "You can't add tasks for this client." };

  const month = safeMonth(String(formData.get("month") || ""));
  try {
    const made = await generateMonthTasks(ok.clientId, month, ok.user.id);
    refresh(ok.clientId);
    const total = made.videos + made.posters;
    if (total === 0) {
      return { ok: true, message: "This month already has everything the plan asks for." };
    }
    const bits = [
      made.videos ? `${made.videos} video${made.videos > 1 ? "s" : ""}` : "",
      made.posters ? `${made.posters} poster${made.posters > 1 ? "s" : ""}` : "",
    ].filter(Boolean);
    return { ok: true, message: `Added ${bits.join(" and ")}.` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not add the tasks." };
  }
}

/** Move a whole month's unfinished tasks forward or back. */
export async function shiftMonthAction(
  _prev: PlanState,
  formData: FormData
): Promise<PlanState> {
  const ok = await guard(formData);
  if (!ok) return { error: "You can't change this client's dates." };

  const month = safeMonth(String(formData.get("month") || ""));
  const days = Math.trunc(Number(formData.get("days")));
  if (!days) return { error: "Enter the number of days to move by." };
  if (Math.abs(days) > 365) return { error: "That's more than a year — use a smaller number." };

  try {
    const moved = await shiftMonthDates(ok.clientId, month, days);
    refresh(ok.clientId);
    if (moved === 0) {
      return { ok: true, message: "Nothing to move — no unfinished tasks with a date this month." };
    }
    const dir = days > 0 ? "later" : "earlier";
    return {
      ok: true,
      message: `Moved ${moved} task${moved > 1 ? "s" : ""} ${Math.abs(days)} day${Math.abs(days) > 1 ? "s" : ""} ${dir}.`,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not move the dates." };
  }
}

/**
 * Put a month's existing tasks onto the two-day rhythm.
 *
 * For the months filled before generating spaced them out, where everything
 * sits on the first. Separate from the "move by N days" control next to it:
 * that shifts a shape that already exists, this gives one to a month that
 * never had it.
 */
export async function respaceMonthAction(
  _prev: PlanState,
  formData: FormData
): Promise<PlanState> {
  const ok = await guard(formData);
  if (!ok) return { error: "You can't change this client's tasks." };
  const month = safeMonth(String(formData.get("month") || ""));

  try {
    const r = await respaceMonth(ok.clientId, month);
    refresh(ok.clientId);
    if (!r.moved) {
      return { error: "Nothing to space out — every task here is posted or finished." };
    }
    return {
      ok: true,
      message:
        `Spread ${r.moved} task${r.moved > 1 ? "s" : ""} two days apart, ` +
        `${fmtDate(r.from)} to ${fmtDate(r.to)}.` +
        (r.skipped ? ` ${r.skipped} left alone — already posted.` : ""),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not space them out." };
  }
}

/**
 * Add or remove an exact number of tasks, ignoring the contract.
 *
 * Separate from Generate on purpose. Generate answers "make this month match
 * what they pay for" and is safe to press twice; this answers "give me three
 * more", which is a different question and must not be idempotent.
 */
export async function adjustTasksAction(
  _prev: PlanState,
  formData: FormData
): Promise<PlanState> {
  const ok = await guard(formData);
  if (!ok) return { error: "You can't change this client's tasks." };

  const month = safeMonth(String(formData.get("month") || ""));
  const kind = String(formData.get("kind") || "video") === "poster" ? "poster" : "video";
  const direction = String(formData.get("direction") || "add");
  const count = Math.trunc(Number(formData.get("count")));

  if (!Number.isFinite(count) || count < 1) return { error: "Enter how many." };
  if (count > 50) return { error: "That's more than 50 — do it in smaller batches." };

  /*
   * Deleting work that has been started, on purpose.
   *
   * Only a super admin, and only when the form says so — the checkbox is
   * rendered after a refusal, so it cannot be the accidental first choice. A
   * crm removing tasks for their own client still gets the safe behaviour.
   */
  const includeStarted =
    Boolean(formData.get("include_started")) && ok.user.role === "super_admin";

  try {
    if (direction === "remove") {
      const { removed, blocked, startedRemoved } = await removeTasks(
        ok.clientId,
        month,
        kind,
        count,
        { includeStarted }
      );
      refresh(ok.clientId);
      if (!removed) {
        return {
          // `blockedOnly` is what makes the override appear: the caller needs
          // to know this failed because of the safety rule and not because
          // there was nothing there.
          blockedOnly: blocked > 0,
          error:
            "Nothing could be removed — the remaining ones have footage, a video, a caption, " +
            "or have already gone to the client.",
        };
      }
      return {
        ok: true,
        blockedOnly: blocked > 0,
        message:
          `Removed ${removed} ${kind}${removed > 1 ? "s" : ""}` +
          (startedRemoved ? `, ${startedRemoved} of them already started` : "") +
          "." +
          (blocked ? ` ${blocked} were left: they have work on them already.` : ""),
      };
    }

    const made = await generateMonthTasks(
      ok.clientId,
      month,
      ok.user.id,
      kind === "poster" ? { videos: 0, posters: count } : { videos: count, posters: 0 }
    );
    refresh(ok.clientId);
    const n = kind === "poster" ? made.posters : made.videos;
    return { ok: true, message: `Added ${n} ${kind}${n > 1 ? "s" : ""}.` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not change the tasks." };
  }
}

/* ------------------------- A month agreed in advance ------------------------- */

/**
 * Set what one month owes, and bill it.
 *
 * The contract holds one pair of numbers for every month there will ever be,
 * so "next month they want twelve videos and two extra posters" could only be
 * recorded by editing the contract — which then reported twelve for the month
 * just closed as well. This writes the month, and the month is what the
 * generator fills to and what the progress bars read.
 *
 * ## The invoice goes out, once
 *
 * Saving a month raises its invoice and sends it — no draft, no second button.
 * That makes the guard the important part rather than the sending: the invoice
 * is claimed with a conditional UPDATE on `invoice_id IS NULL`, so a save
 * pressed twice, a double-click, or a retry after a timeout all find the month
 * already claimed and send nothing. Only the call that wins the UPDATE bills.
 *
 * Correcting a month that has already been billed is deliberately allowed —
 * the counts and the amount are rewritten and the invoice is left standing.
 * A wrong invoice is cancelled and reissued on the Payments page, where
 * invoices live; silently voiding a client's invoice from a planning screen
 * would be a worse surprise than the one it is fixing.
 */
export async function saveMonthPlanAction(
  _prev: PlanState,
  formData: FormData
): Promise<PlanState> {
  const ok = await guard(formData);
  if (!ok) return { error: "You can't change this client's plan." };

  const month = safeMonth(String(formData.get("month") || ""));
  const videos = Math.trunc(Number(formData.get("videos")));
  const posters = Math.trunc(Number(formData.get("posters")));
  const amount = Number(formData.get("amount"));
  const note = String(formData.get("note") || "").trim() || null;

  if (!Number.isFinite(videos) || videos < 0) return { error: "How many videos this month?" };
  if (!Number.isFinite(posters) || posters < 0) return { error: "How many posters this month?" };
  if (videos + posters === 0) return { error: "A month with no videos and no posters is not a plan." };
  if (videos + posters > 200) return { error: "That's more than 200 pieces in one month — check the numbers." };
  if (!Number.isFinite(amount) || amount < 0) return { error: "Enter the amount for this month." };

  try {
    const saved = await saveMonthPlan({
      clientId: ok.clientId,
      month,
      videos,
      posters,
      amount,
      note,
      createdBy: ok.user.id,
    });
    if (!saved) {
      return {
        error:
          "The month-plans table isn't there yet. Apply it from Settings → Database, then save again.",
      };
    }

    /*
     * Bill it, if nobody has. `claimMonthInvoice` is what decides — an UPDATE
     * that only matches while `invoice_id` is null — so this is safe to reach
     * twice and only one invoice can ever be sent for a month.
     *
     * The invoice is raised first and the claim taken after, which is the
     * order that can only ever fail safe: a crash between them leaves an
     * invoice that exists and a month that will try again, and a duplicate
     * caught on the Payments page beats a client billed for a month the portal
     * thinks it never billed.
     */
    const existing = await monthPlanFor(ok.clientId, month);
    let billed: string | null = existing?.invoiceNo ?? null;
    let alreadyBilled = Boolean(existing?.invoiceId);

    if (!alreadyBilled && amount > 0) {
      const raised = await raiseInvoice({
        clientId: ok.clientId,
        amount,
        description: `Content plan — ${monthRangeLabel(month)}`,
        periodMonth: month,
        createdBy: ok.user.id,
      }).catch(() => null);

      if (raised) {
        const claimed = await claimMonthInvoice(ok.clientId, month, raised.id);
        // Lost the race to a save a moment earlier: that one's invoice stands
        // and this one is reported so somebody can void it.
        if (!claimed) alreadyBilled = true;
        billed = raised.invoiceNo;
      }
    }

    refresh(ok.clientId);
    const shape = `${videos} video${videos === 1 ? "" : "s"}, ${posters} poster${posters === 1 ? "" : "s"}`;
    return {
      ok: true,
      message:
        billed && !alreadyBilled
          ? `${monthRangeLabel(month)}: ${shape}. Invoice ${billed} sent for ${fmtMoney(amount)}.`
          : billed
            ? `${monthRangeLabel(month)}: ${shape}. Invoice ${billed} was already raised for this month.`
            : `${monthRangeLabel(month)}: ${shape}.`,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not save the plan." };
  }
}

/** Drop a month's own plan, so it follows the contract again. */
export async function clearMonthPlanAction(
  _prev: PlanState,
  formData: FormData
): Promise<PlanState> {
  const ok = await guard(formData);
  if (!ok) return { error: "You can't change this client's plan." };

  const month = safeMonth(String(formData.get("month") || ""));
  const done = await clearMonthPlan(ok.clientId, month);
  if (!done) return { error: "Could not clear the plan." };
  refresh(ok.clientId);
  // The invoice it raised is untouched and deliberately so — see above.
  return { ok: true, message: `${monthRangeLabel(month)} follows the contract again.` };
}
