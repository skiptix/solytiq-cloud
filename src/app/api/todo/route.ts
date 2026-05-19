import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET() {
  const sections = await prisma.section.findMany({
    orderBy: { order: "asc" },
    include: {
      items: {
        orderBy: { order: "asc" },
      },
    },
  });

  const countdown = await prisma.countdown.findFirst();

  return NextResponse.json({ sections, countdown });
}
