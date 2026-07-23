import { redirect } from "next/navigation";

// The interview feature currently lives on the shared (English UI) route; Arabic
// visitors who hit /ar/interview directly are sent there instead of a 404.
export default function ArRedirect() {
  redirect("/interview");
}
