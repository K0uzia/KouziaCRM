import { ThreadView } from "@/components/inbox/thread-view";

type Props = { params: Promise<{ threadId: string }> };

export default async function InboxThreadPage({ params }: Props) {
  const { threadId } = await params;
  return <ThreadView threadId={threadId} />;
}
