import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function POST() {
  await prisma.item.updateMany({
    data: { checked: false },
  });
  return NextResponse.json({ success: true });
}
