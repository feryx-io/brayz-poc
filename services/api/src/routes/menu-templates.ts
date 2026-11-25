import type { FastifyInstance } from 'fastify';
import { ApplyMenuTemplateInput, MENU_TEMPLATES, getMenuTemplate, templateGroupsFor } from '@brayz/shared';
import { forTenant, prisma, writeAudit } from '@brayz/db';
import { HttpError, notFound, parse } from '../lib/http.js';
import { applyMenuTemplate } from '../lib/menuTemplates.js';
import { requireTenant, requireTenantRole } from '../plugins/auth.js';

/**
 * Menu templates: a starting menu for a restaurant with none, and a library
 * of option groups for one that has items but nothing a caller can choose.
 * The template data is code in `@brayz/shared`; these routes list it and
 * lay it onto a location's menu. Manager and up, audited — it creates
 * sections, items and priced options, the same as a hand edit would.
 */
export async function menuTemplateRoutes(app: FastifyInstance): Promise<void> {
  // The catalogue, shaped for a picker: what each template would create,
  // and which starter items get which groups, so the owner sees the shape
  // before applying rather than after.
  app.get('/v1/menu-templates', async (request) => {
    requireTenant(request);
    return {
      templates: MENU_TEMPLATES.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        categories: t.categories.map((c) => ({
          name: c.name,
          items: c.items.map((i) => ({
            name: i.name,
            groups: templateGroupsFor(t, { name: i.name, category: c.name }).map((g) => g.spec.name),
          })),
        })),
        groups: Object.values(t.groups).map((g) => ({
          name: g.name,
          selectionType: g.selectionType,
          required: g.required,
          options: g.options.length,
        })),
      })),
    };
  });

  app.post('/v1/locations/:locationId/menu/template', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { locationId } = request.params as { locationId: string };
    // parse() types by the schema's input; the value it returns has the defaults applied.
    const input = parse(ApplyMenuTemplateInput, request.body) as ApplyMenuTemplateInput;
    const template = getMenuTemplate(input.templateId);
    if (!template) throw new HttpError(404, `No menu template "${input.templateId}"`, 'template_not_found');

    const db = forTenant(tenantId);
    const location = await db.location.findFirst({ where: { id: locationId }, select: { id: true } });
    if (!location) throw notFound('Location');
    const menu =
      (await db.menu.findFirst({ where: { locationId, active: true } })) ??
      (await db.menu.create({ data: { tenantId, locationId, name: 'Main Menu' } }));

    const result = await prisma.$transaction(async (tx) => {
      if (input.mode === 'replace') await tx.menuCategory.deleteMany({ where: { menuId: menu.id } });
      return applyMenuTemplate(tx, menu.id, template, { sections: input.sections, starterItems: input.starterItems });
    });

    await writeAudit({
      tenantId,
      locationId,
      actorId: request.auth?.userId ?? null,
      action: 'menu.template.applied',
      targetType: 'menu',
      targetId: menu.id,
      metadata: { templateId: template.id, mode: input.mode, sections: input.sections, starterItems: input.starterItems, ...result },
    });
    return reply.status(201).send({ templateId: template.id, ...result });
  });
}
