/**
 * Closes the popup on client-side navigation.
 *
 * A parallel slot keeps showing its last match until something else matches,
 * so without this catch-all the task popup would stay on screen after you
 * navigated to, say, the dashboard.
 */
export default function CloseModal() {
  return null;
}
