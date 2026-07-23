import { redirect } from "next/navigation";

// The shareable score card lives on the shared route; /ar/score/{id} sends the
// Arabic visitor there with the Arabic rendering flag instead of a 404.
export default async function ArScoreRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/score/${encodeURIComponent(id)}?lang=ar`);
}
