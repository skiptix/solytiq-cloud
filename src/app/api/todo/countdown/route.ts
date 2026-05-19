import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function PATCH(request: NextRequest) {
  const { title, date } = await request.json();
  const countdown = await prisma.countdown.upsert({
    where: { id: 1 },
    update: { title, date: new Date(date) },
    create: { id: 1, title, date: new Date(date) },
  });
  return NextResponse.json(countdown);
}
