import type { Unit, Bill, Reading, Adjustment, LineItem } from "../types";

export interface CalculatedInvoice {
  unit_id: string;
  unit_name: string;
  tenant_email: string;
  amount: number;
  line_items: LineItem[];
}

/**
 * Calculate invoices for all units based on bill data, readings, and adjustments.
 * This runs entirely client-side.
 */
export function calculateInvoices(
  bill: Bill,
  units: Unit[],
  readings: Reading[],
  adjustments: Adjustment[]
): CalculatedInvoice[] {
  const parsedData = bill.parsed_data;
  const totalSqft = units.reduce((sum, u) => sum + u.sqft, 0);

  // Get water/sewer service data from parsed bill
  const waterService = findService(parsedData?.services, "Water");
  const sewerService = findService(parsedData?.services, "Sewer");

  // Calculate total meter readings
  const totalUsage = readings.reduce((sum, r) => sum + r.reading, 0);

  // Calculate cost per CCF
  const waterCostPerCcf =
    waterService && totalUsage > 0 ? waterService.total / totalUsage : 0;
  const sewerCostPerCcf =
    sewerService && totalUsage > 0 ? sewerService.total / totalUsage : 0;

  // Calculate common area usage (total billed - submeter readings)
  const waterServiceUsage = getServiceUsage(waterService);
  const commonAreaWater = Math.max(0, waterServiceUsage - totalUsage);
  const commonAreaWaterCost = commonAreaWater * waterCostPerCcf;
  const commonAreaSewerCost = commonAreaWater * sewerCostPerCcf;

  return units.map((unit) => {
    const unitReading =
      readings.find((r) => r.unit_id === unit.id)?.reading || 0;
    const sqftRatio = totalSqft > 0 ? unit.sqft / totalSqft : 0;

    const lineItems: LineItem[] = [];

    // Water usage charge
    if (unitReading > 0 && waterCostPerCcf > 0) {
      lineItems.push({
        description: `Water Usage (${unitReading.toFixed(2)} CCF)`,
        amount: round(unitReading * waterCostPerCcf),
      });
    }

    // Sewer usage charge
    if (unitReading > 0 && sewerCostPerCcf > 0) {
      lineItems.push({
        description: `Sewer Usage`,
        amount: round(unitReading * sewerCostPerCcf),
      });
    }

    // Common area water (split by sqft)
    if (commonAreaWaterCost > 0 && sqftRatio > 0) {
      lineItems.push({
        description: `Common Area Water`,
        amount: round(sqftRatio * commonAreaWaterCost),
      });
    }

    // Common area sewer (split by sqft)
    if (commonAreaSewerCost > 0 && sqftRatio > 0) {
      lineItems.push({
        description: `Common Area Sewer`,
        amount: round(sqftRatio * commonAreaSewerCost),
      });
    }

    // TODO: Add garbage/recycling based on trash_cans
    // This requires matching trash can sizes to bill line items

    // Adjustments assigned to this unit
    adjustments.forEach((adj) => {
      if (adj.assigned_unit_ids.includes(unit.id)) {
        const splitCount = adj.assigned_unit_ids.length;
        lineItems.push({
          description: adj.description,
          amount: round(adj.cost / splitCount),
        });
      }
    });

    const total = lineItems.reduce((sum, li) => sum + li.amount, 0);

    return {
      unit_id: unit.id,
      unit_name: unit.name,
      tenant_email: unit.email,
      amount: round(total),
      line_items: lineItems,
    };
  });
}

/**
 * Find a service by partial name match (case-insensitive)
 */
function findService(
  services: Record<string, { total: number; parts: unknown[] }> | undefined,
  serviceName: string
): { total: number; parts: unknown[] } | null {
  if (!services) return null;

  for (const [key, value] of Object.entries(services)) {
    if (key.toLowerCase().includes(serviceName.toLowerCase())) {
      return value;
    }
  }
  return null;
}

/**
 * Get total usage from a service's parts
 */
function getServiceUsage(
  service: { total: number; parts: unknown[] } | null
): number {
  if (!service || !service.parts) return 0;

  return service.parts.reduce((sum: number, part: unknown) => {
    const p = part as { usage?: number };
    return sum + (p.usage || 0);
  }, 0);
}

/**
 * Round to 2 decimal places
 */
function round(num: number): number {
  return Math.round(num * 100) / 100;
}
