import type { Metadata } from "next";
import AccountClient from "../components/AccountClient";

export const metadata: Metadata = {
  title: "Account — your resumes & scans | cv.rabit.sa",
  robots: { index: false, follow: false },
};

export default function AccountPage() {
  return <AccountClient />;
}
