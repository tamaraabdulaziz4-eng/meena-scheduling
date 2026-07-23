import { redirect } from "next/navigation";

// The linkedin feature currently lives on the shared (English UI) route; Arabic
// visitors who hit /ar/linkedin directly are sent there instead of a 404.
export default function ArRedirect() {
  redirect("/linkedin");
}
