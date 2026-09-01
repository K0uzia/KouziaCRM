import { MailLayout } from "@/pages/messaging/MailLayout";

/** Client mail plein écran (dossiers / liste, ou lecture). */
export function InboxPage() {
  return (
    <div className="h-full min-h-0">
      <MailLayout />
    </div>
  );
}
