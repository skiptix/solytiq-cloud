import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";

export async function middleware(request: NextRequest) {
  const session = await getSession();

  // If the user is not authenticated and trying to access any page other than /login
  // we redirect them to /login.
  // We also exclude api routes and static files.
  if (
    !session &&
    !request.nextUrl.pathname.startsWith("/login") &&
    !request.nextUrl.pathname.startsWith("/api/auth") &&
    request.nextUrl.pathname !== "/favicon.ico" &&
    !request.nextUrl.pathname.startsWith("/_next")
  ) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
