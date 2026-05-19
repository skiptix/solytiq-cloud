import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const { sectionId, name, note, badge } = await request.json();
  const lastItem = await prisma.item.findFirst({
    where: { sectionId },
    orderBy: { order: "desc" },
  });
  const order = lastItem ? lastItem.order + 1 : 0;

  const item = await prisma.item.create({
    data: { sectionId, name, note, badge, order },
  });
  return NextResponse.json(item);
}
