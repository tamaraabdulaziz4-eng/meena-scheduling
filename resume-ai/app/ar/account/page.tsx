import type { Metadata } from "next";
import AccountClient from "../../components/AccountClient";

export const metadata: Metadata = {
  title: "حسابي — سيرك ومسوحك | سيرة",
  robots: { index: false, follow: false },
};

export default function ArabicAccountPage() {
  return <AccountClient initialLang="ar" />;
}
