import { redirect } from "next/navigation";

// The login feature currently lives on the shared (English UI) route; Arabic
// visitors who hit /ar/login directly are sent there instead of a 404.
export default function ArRedirect() {
  redirect("/login");
}
