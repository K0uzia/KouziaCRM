import Link from "next/link";
import { ComposeForm } from "@/components/inbox/compose-form";

export default function ComposePage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <Link href="/inbox" className="text-sm text-primary hover:underline">
          ← Inbox
        </Link>
        <h1 className="mt-2 font-[family-name:var(--font-display)] text-3xl text-primary">
          Nouveau message
        </h1>
      </div>
      <ComposeForm />
    </div>
  );
}
