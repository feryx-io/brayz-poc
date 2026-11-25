import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Seeds the "Mario's Pizza" demo tenant from the implementation plan's first
 * vertical slice: one tenant, one location, hours, and a small pickup menu.
 */
async function main() {
  const tenant = await prisma.tenant.upsert({
    where: { id: '00000000-0000-0000-0000-0000000000a1' },
    update: {},
    create: { id: '00000000-0000-0000-0000-0000000000a1', name: "Mario's Pizza" },
  });

  const location = await prisma.location.upsert({
    where: { id: '00000000-0000-0000-0000-0000000000b1' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-0000000000b1',
      tenantId: tenant.id,
      name: "Mario's Pizza — Albany",
      timezone: 'America/New_York',
      addressLine1: '123 Lark St',
      city: 'Albany',
      region: 'NY',
      postalCode: '12210',
      mainPhone: '+15185559898',
      escalationPhone: '+15185550000',
      pickupEnabled: true,
      aiGreetings: [
        "Thanks for calling Mario's Pizza, this is {staff_name}. How can I help you?",
        "Mario's Pizza, {staff_name} speaking. What can I get started for you?",
      ],
    },
  });

  // Open 11:00–22:00 every day (minutes from midnight: 660–1320).
  await prisma.locationHours.deleteMany({ where: { locationId: location.id } });
  await prisma.locationHours.createMany({
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      locationId: location.id,
      dayOfWeek,
      opensAt: 11 * 60,
      closesAt: 22 * 60,
    })),
  });

  const menu = await prisma.menu.upsert({
    where: { id: '00000000-0000-0000-0000-0000000000c1' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-0000000000c1',
      tenantId: tenant.id,
      locationId: location.id,
      name: 'Main Menu',
    },
  });

  const categories: Record<string, string> = {};
  for (const [i, name] of ['Pizza', 'Wings', 'Sides', 'Drinks'].entries()) {
    const cat = await prisma.menuCategory.upsert({
      where: { id: `00000000-0000-0000-0000-00000000c1${i}0` },
      update: {},
      create: {
        id: `00000000-0000-0000-0000-00000000c1${i}0`,
        menuId: menu.id,
        name,
        sortOrder: i,
      },
    });
    categories[name] = cat.id;
  }

  const items: Array<[string, string, number, string?]> = [
    ['Pizza', 'Large Cheese Pizza', 1499],
    ['Pizza', 'Large Pepperoni Pizza', 1699],
    ['Wings', '10 Wings', 1199],
    ['Sides', 'Garlic Knots', 599],
    ['Drinks', '2-Liter Soda', 399],
  ];
  for (const [cat, name, priceCents] of items) {
    await prisma.menuItem.create({
      data: { categoryId: categories[cat]!, name, priceCents },
    });
  }

  // Transfer destinations the AI routes to by caller intent.
  await prisma.locationTransferTarget.deleteMany({ where: { locationId: location.id } });
  await prisma.locationTransferTarget.createMany({
    data: [
      {
        locationId: location.id,
        key: 'manager',
        label: 'a manager',
        description: 'Caller wants a manager or to escalate a complaint.',
        destination: location.escalationPhone ?? '+15185550000',
        sortOrder: 0,
      },
      {
        locationId: location.id,
        key: 'ordering',
        label: 'someone to take your order',
        description: 'Caller wants to place an order with a person instead of the AI.',
        destination: location.mainPhone ?? '+15185559898',
        sortOrder: 1,
      },
      {
        locationId: location.id,
        key: 'bob',
        label: 'Bob, the owner',
        description: 'Caller asks for Bob, or the owner, by name.',
        destination: 'sip:bob@pbx.example.com',
        sortOrder: 2,
      },
    ],
  });

  // eslint-disable-next-line no-console
  console.log(`Seeded tenant=${tenant.id} location=${location.id} menu=${menu.id}`);
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
