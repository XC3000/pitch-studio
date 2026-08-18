import { clerkMiddleware } from "@clerk/nextjs/server";

/**
 * Only the admin studio requires auth. The viewer (/p/…), Q&A, tracking and
 * webhooks are public by design — share links are the viewer's credential.
 */
export default clerkMiddleware(async (auth, req) => {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/o") || pathname.startsWith("/onboarding")) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and static files
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest|mp4|webm)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
