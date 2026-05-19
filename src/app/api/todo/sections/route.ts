import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const { title, icon } = await request.json();
  const lastSection = await prisma.section.findFirst({
    orderBy: { order: "desc" },
  });
  const order = lastSection ? lastSection.order + 1 : 0;

  const section = await prisma.section.create({
    data: { title, icon, order },
  });
  return NextResponse.json(section);
}
