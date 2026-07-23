import { redirect } from "next/navigation";

// The account feature currently lives on the shared (English UI) route; Arabic
// visitors who hit /ar/account directly are sent there instead of a 404.
export default function ArRedirect() {
  redirect("/account");
}
