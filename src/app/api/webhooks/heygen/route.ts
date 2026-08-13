import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { heygenCompletedEvent, inngest } from "@/inngest/client";

/**
 * HeyGen render webhook (avatar_video.success / avatar_video.fail) →
 * re-emitted as the Inngest event `render-scene` is waiting on. Configure the
 * endpoint in HeyGen with events avatar_video.* and set HEYGEN_WEBHOOK_SECRET
 * to the endpoint's secret; when unset (local dev) signatures are not checked
 * and the poll fallback covers missed deliveries anyway.
 */
export async function POST(req: Request) {
  const raw = await req.text();

  const secret = process.env.HEYGEN_WEBHOOK_SECRET;
  if (secret) {
    const signature = req.headers.get("signature") ?? "";
    const expected = createHmac("sha256", secret).update(raw).digest("hex");
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return NextResponse.json({ error: "bad signature" }, { status: 401 });
    }
  }

  let body: {
    event_type?: string;
    event_data?: { video_id?: string; url?: string; msg?: string };
  };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const videoId = body.event_data?.video_id;
  if (!videoId || !body.event_type?.startsWith("avatar_video.")) {
    return NextResponse.json({ ok: true, ignored: true });
  }

  await inngest.send(
    heygenCompletedEvent.create({
      heygenVideoId: videoId,
      status: body.event_type === "avatar_video.success" ? "success" : "failed",
      videoUrl: body.event_data?.url,
    }),
  );

  return NextResponse.json({ ok: true });
}
