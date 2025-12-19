import type {
  Unit,
  Bill,
  Reading,
  Adjustment,
  LineItem,
  LineItemCategory,
  SolidWasteItem,
  SolidWasteAssignment,
  SolidWasteValidation,
  SolidWasteServiceType,
  BillItem,
  ServiceData,
} from "../types";

export interface CalculatedInvoice {
  unit_id: string;
  unit_name: string;
  tenant_email: string;
  amount: number;
  line_items: LineItem[];
}

export interface BillTotalsValidation {
  is_valid: boolean;
  bill_total: number;
  calculated_total: number;
  difference: number;
  errors: string[];
}

/**
 * Represents a line item that needs to be distributed across units
 */
interface DistributableItem {
  description: string;
  cost: number;
  splitMethod: "usage" | "sqft";
  serviceName: string;
  category: LineItemCategory;
}

/**
 * Calculate invoices for all units based on bill data, readings, and adjustments.
 * This runs entirely client-side.
 *
 * Each bill line item is split based on whether it has a rate:
 * - Items with a rate (usage-based) → split by water usage ratio
 * - Items without a rate (base charges) → split by square footage
 */
export function calculateInvoices(
  bill: Bill,
  units: Unit[],
  readings: Reading[],
  adjustments: Adjustment[]
): CalculatedInvoice[] {
  // Get weights for distribution
  const usageWeights = units.map(
    (u) => readings.find((r) => r.unit_id === u.id)?.reading || 0
  );
  const sqftWeights = units.map((u) => u.sqft);

  // Collect all distributable items from water, sewer, and drainage services
  const distributableItems: DistributableItem[] = [];

  // Helper to process services - checks name for Water/Sewer/Drainage patterns
  const processService = (serviceName: string, serviceData: ServiceData) => {
    // Skip solid waste (handled separately) and adjustments
    const lowerName = serviceName.toLowerCase();
    if (lowerName.includes("solid waste") || lowerName.includes("adjustment")) {
      return;
    }

    // Determine the display name for this service
    let displayName = serviceName;
    if (lowerName.includes("water")) displayName = "Water";
    else if (lowerName.includes("sewer")) displayName = "Sewer";
    else if (lowerName.includes("drainage")) displayName = "Drainage";

    // For drainage, always split by sqft
    const isDrainage = lowerName.includes("drainage");

    for (const part of serviceData.parts || []) {
      for (const item of part.items || []) {
        // Skip items with 0 cost
        if (item.cost === 0) continue;

        // Determine split method:
        // - Items with a rate (e.g., "6.35 CCF @ $5.95") → split by usage
        // - Items without a rate (base charges) → split by sqft
        // - Drainage is always by sqft
        const splitMethod =
          isDrainage || item.rate === undefined ? "sqft" : "usage";

        // Determine category for grouping
        let category: LineItemCategory;
        if (isDrainage) {
          category = "drainage";
        } else if (lowerName.includes("sewer")) {
          category = "sewer";
        } else if (lowerName.includes("water")) {
          category = splitMethod === "usage" ? "water_usage" : "water_sqft";
        } else {
          category = splitMethod === "usage" ? "water_usage" : "water_sqft";
        }

        // Build description with usage info if available
        let description = item.description;
        if (item.usage !== undefined && item.rate !== undefined) {
          description = `${item.description} (${item.usage} CCF @ $${item.rate.toFixed(2)})`;
        }

        distributableItems.push({
          description,
          cost: item.cost,
          splitMethod,
          serviceName: displayName,
          category,
        });
      }
    }
  };

  // Process all services
  if (bill.services) {
    for (const [serviceName, serviceData] of Object.entries(bill.services)) {
      processService(serviceName, serviceData as ServiceData);
    }
  }

  // Pre-calculate distributions for each item
  // For usage-based items, pass sqftWeights as fallback for units with zero usage
  const itemDistributions: number[][] = distributableItems.map((item) => {
    if (item.splitMethod === "usage") {
      return distributeByWeight(item.cost, usageWeights, sqftWeights);
    } else {
      return distributeByWeight(item.cost, sqftWeights);
    }
  });

  // Pre-calculate fair distributions for adjustments
  const adjustmentDistributions = new Map<string, Map<string, number>>();
  for (const adj of adjustments) {
    if (adj.assigned_unit_ids.length > 0) {
      const amounts = distributeEvenly(adj.cost, adj.assigned_unit_ids.length);
      const unitAmounts = new Map<string, number>();
      adj.assigned_unit_ids.forEach((unitId, idx) => {
        unitAmounts.set(unitId, amounts[idx]);
      });
      adjustmentDistributions.set(adj.id, unitAmounts);
    }
  }

  return units.map((unit, unitIndex) => {
    const lineItems: LineItem[] = [];

    // Add line items from distributable items
    distributableItems.forEach((item, itemIndex) => {
      const amount = itemDistributions[itemIndex][unitIndex];
      if (amount === 0) return;

      // Build description with split method indicator
      let desc = `${item.serviceName}: ${item.description}`;
      if (item.splitMethod === "usage") {
        desc += ` [by usage]`;
      } else {
        desc += ` [by sqft]`;
      }

      lineItems.push({
        description: desc,
        amount,
        category: item.category,
      });
    });

    // Adjustments assigned to this unit (with fair distribution)
    adjustments.forEach((adj) => {
      const unitAmounts = adjustmentDistributions.get(adj.id);
      const amount = unitAmounts?.get(unit.id);
      if (amount !== undefined) {
        lineItems.push({
          description: adj.description,
          amount: amount,
          category: "adjustment",
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
 * Round to 2 decimal places
 */
function round(num: number): number {
  return Math.round(num * 100) / 100;
}

/**
 * Distribute a total amount among N recipients fairly, handling rounding.
 * Uses the "largest remainder method" (Hamilton's method) to ensure the sum
 * of distributed amounts equals exactly the total.
 *
 * @param total - The total amount to distribute
 * @param count - Number of recipients
 * @returns Array of amounts that sum to exactly total
 */
function distributeEvenly(total: number, count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [total];
  
  // Calculate exact share in cents to avoid floating point issues
  const totalCents = Math.round(total * 100);
  const baseShareCents = Math.floor(totalCents / count);
  const remainderCents = totalCents - (baseShareCents * count);
  
  // Each recipient gets the base share, and the first 'remainderCents'
  // recipients get 1 extra cent
  const amounts: number[] = [];
  for (let i = 0; i < count; i++) {
    const extraCent = i < remainderCents ? 1 : 0;
    amounts.push((baseShareCents + extraCent) / 100);
  }
  
  return amounts;
}

/**
 * Distribute a total amount among recipients with different weights.
 * Uses largest remainder method to ensure the sum equals exactly the total.
 *
 * @param total - The total amount to distribute
 * @param weights - Array of weights (e.g., water usage in gallons)
 * @param fallbackWeights - Optional fallback weights to use for recipients with zero primary weight
 * @returns Array of amounts that sum to exactly total
 */
function distributeByWeight(total: number, weights: number[], fallbackWeights?: number[]): number[] {
  if (weights.length === 0) return [];
  
  // Calculate effective weights: use primary weight if > 0, else fallback weight
  // This allows units with zero usage to fall back to sqft-based distribution
  const effectiveWeights = weights.map((w, i) => {
    if (w > 0) return w;
    if (fallbackWeights && fallbackWeights[i] > 0) return fallbackWeights[i];
    return 0;
  });
  
  const totalWeight = effectiveWeights.reduce((sum, w) => sum + w, 0);
  if (totalWeight <= 0) return weights.map(() => 0);
  
  const totalCents = Math.round(total * 100);
  
  // Calculate exact shares and their remainders
  const shares = effectiveWeights.map(w => {
    const exactShare = (w / totalWeight) * totalCents;
    const floored = Math.floor(exactShare);
    const remainder = exactShare - floored;
    return { floored, remainder };
  });
  
  // Calculate how many cents we need to distribute
  const flooredTotal = shares.reduce((sum, s) => sum + s.floored, 0);
  let remainingCents = totalCents - flooredTotal;
  
  // Sort indices by remainder (descending) to give extra cents to those
  // who lost the most from flooring
  const indices = shares.map((_, i) => i);
  indices.sort((a, b) => shares[b].remainder - shares[a].remainder);
  
  // Distribute remaining cents
  const finalShares = shares.map(s => s.floored);
  for (const idx of indices) {
    if (remainingCents <= 0) break;
    finalShares[idx]++;
    remainingCents--;
  }
  
  return finalShares.map(cents => cents / 100);
}

/**
 * Round an array of amounts to cents while ensuring they sum to exactly the target.
 * Only applies if the unrounded sum matches the target (within float tolerance).
 * Uses largest remainder method for fair distribution of rounding cents.
 *
 * @param unroundedAmounts - Array of amounts before rounding
 * @param targetTotal - The exact total we need (already rounded)
 * @returns Array of rounded amounts that sum to targetTotal, or just rounded amounts if no match
 */
function roundToTotal(unroundedAmounts: number[], targetTotal: number): number[] {
  if (unroundedAmounts.length === 0) return [];
  
  const unroundedSum = unroundedAmounts.reduce((sum, a) => sum + a, 0);
  
  // Check if unrounded sum matches target within float tolerance (0.001)
  // This means the math is correct, we just need to handle cent rounding
  const isExactMatch = Math.abs(unroundedSum - targetTotal) < 0.001;
  
  if (!isExactMatch) {
    // Not an exact match - just round each amount individually
    // Validation will catch the mismatch
    return unroundedAmounts.map(a => round(a));
  }
  
  // Use largest remainder method to distribute rounding fairly
  const targetCents = Math.round(targetTotal * 100);
  
  // Calculate floor and remainder for each amount
  const amountData = unroundedAmounts.map(a => {
    const exactCents = a * 100;
    const floored = Math.floor(exactCents);
    const remainder = exactCents - floored;
    return { floored, remainder };
  });
  
  // Calculate how many extra cents we need to distribute
  const flooredTotal = amountData.reduce((sum, d) => sum + d.floored, 0);
  let extraCents = targetCents - flooredTotal;
  
  // Sort indices by remainder (descending) to give cents to those who lost most
  const indices = amountData.map((_, i) => i);
  indices.sort((a, b) => amountData[b].remainder - amountData[a].remainder);
  
  // Distribute extra cents
  const finalCents = amountData.map(d => d.floored);
  for (const idx of indices) {
    if (extraCents <= 0) break;
    finalCents[idx]++;
    extraCents--;
  }
  
  return finalCents.map(cents => cents / 100);
}

// ============================================================================
// SOLID WASTE FUNCTIONS
// ============================================================================

/**
 * Parse solid waste items from bill's services.
 * Extracts Garbage, Food/Yard Waste (Compost), and Recycle items.
 */
export function parseSolidWasteItems(bill: Bill): SolidWasteItem[] {
  const services = bill.services;
  if (!services) return [];

  // Find solid waste service - it's called "Solid Waste Service" in the parsed data
  const solidWasteServiceName = Object.keys(services).find(
    (name) =>
      name.toLowerCase().includes("solid waste") ||
      name.toLowerCase().includes("garbage")
  );

  if (!solidWasteServiceName) return [];

  const solidWasteService = services[solidWasteServiceName];
  if (!solidWasteService?.parts) return [];

  const items: SolidWasteItem[] = [];
  let itemIndex = 0;

  for (const part of solidWasteService.parts) {
    for (const item of part.items || []) {
      const parsed = parseSolidWasteItemFromBillItem(item, itemIndex);
      if (parsed) {
        items.push(parsed);
        itemIndex++;
      }
    }
  }

  return items;
}

/**
 * Parse a single bill item into a SolidWasteItem
 */
function parseSolidWasteItemFromBillItem(
  item: BillItem,
  index: number
): SolidWasteItem | null {
  // Try to extract size and count from the item
  // First check if they're already parsed, otherwise try to extract from description
  let size = item.size;
  let count = item.count;

  if (!size || !count) {
    // Try to parse from description using the trash regex pattern
    // Format: "N-Description SIZE Gal..." e.g., "2-Garbage 32 Gal 1X Weekly"
    const trashMatch = item.description.match(
      /^(\d+)-(.+?)\s+(\d+)\s*Gal/i
    );
    if (trashMatch) {
      count = parseInt(trashMatch[1], 10);
      size = parseInt(trashMatch[3], 10);
    }
  }

  // Skip items without size or count (like tax info lines)
  if (!size || !count) return null;

  // Determine service type from description
  let serviceType: SolidWasteServiceType;
  const descLower = item.description.toLowerCase();

  if (descLower.includes("garbage")) {
    serviceType = "Garbage";
  } else if (
    descLower.includes("food") ||
    descLower.includes("yard") ||
    descLower.includes("compost")
  ) {
    serviceType = "Food/Yard Waste";
  } else if (descLower.includes("recycle")) {
    serviceType = "Recycle";
  } else {
    return null; // Unknown service type
  }

  // Extract frequency from description
  let frequency = "";
  if (descLower.includes("every other")) {
    frequency = "Every Other Week";
  } else if (descLower.includes("weekly") || descLower.includes("1x")) {
    frequency = "Weekly";
  }

  // Clean up description - remove the count prefix if present
  let cleanDescription = item.description;
  const descMatch = cleanDescription.match(/^\d+-(.+)/);
  if (descMatch) {
    cleanDescription = descMatch[1].trim();
  }

  // Use fair distribution for cost_per_unit
  // distributeEvenly returns an array where the sum equals exactly item.cost
  const distributedCosts = distributeEvenly(item.cost, count);
  
  return {
    id: `sw-${index}`,
    service_type: serviceType,
    description: cleanDescription,
    size: size,
    count: count,
    cost: item.cost,
    // Store all distributed costs so we can assign them fairly
    distributed_costs: distributedCosts,
    cost_per_unit: distributedCosts[0] || 0, // First slot's cost (for display)
    start_date: item.start || "",
    end_date: item.end || "",
    frequency,
  };
}

/**
 * Get the total solid waste service cost from the bill
 */
export function getSolidWasteTotal(bill: Bill): number {
  const services = bill.services;
  if (!services) return 0;

  const solidWasteServiceName = Object.keys(services).find(
    (name) =>
      name.toLowerCase().includes("solid waste") ||
      name.toLowerCase().includes("garbage")
  );

  if (!solidWasteServiceName) return 0;

  return services[solidWasteServiceName].total || 0;
}

/**
 * Auto-assign solid waste items to units based on their defaults.
 * Returns assignments for all units that can be matched.
 */
export function autoAssignSolidWaste(
  bill: Bill,
  units: Unit[]
): Map<string, Omit<SolidWasteAssignment, "id" | "created_at">> {
  const items = parseSolidWasteItems(bill);
  const assignments = new Map<
    string,
    Omit<SolidWasteAssignment, "id" | "created_at">
  >();

  // Group items by service type and size
  const garbageItems = items.filter((i) => i.service_type === "Garbage");
  const compostItems = items.filter((i) => i.service_type === "Food/Yard Waste");
  const recycleItems = items.filter((i) => i.service_type === "Recycle");

  // Track which slot we're at for each item (for fair cost distribution)
  const itemSlot = new Map<string, number>();
  items.forEach((item) => itemSlot.set(item.id, 0));

  // Assign items to each unit based on their defaults
  for (const unit of units) {
    const defaults = unit.solid_waste_defaults;
    if (!defaults) continue;

    const garbageAssignments: SolidWasteAssignment["garbage_items"] = [];
    const compostAssignments: SolidWasteAssignment["compost_items"] = [];
    const recycleAssignments: SolidWasteAssignment["recycle_items"] = [];

    // Helper to get fair cost for the next slot of an item
    const getFairCost = (item: SolidWasteItem): number | null => {
      const slot = itemSlot.get(item.id) || 0;
      if (slot >= item.count) return null; // No more slots available
      
      // Use distributed_costs if available, otherwise fall back to cost_per_unit
      const costs = item.distributed_costs || distributeEvenly(item.cost, item.count);
      const cost = costs[slot] ?? item.cost_per_unit;
      
      itemSlot.set(item.id, slot + 1);
      return cost;
    };

    // Find matching garbage items by size
    for (const item of garbageItems) {
      if (item.size === defaults.garbage_size) {
        const cost = getFairCost(item);
        if (cost !== null) {
          garbageAssignments.push({
            item_id: item.id,
            description: item.description,
            size: item.size,
            cost: cost,
            start_date: item.start_date,
            end_date: item.end_date,
          });
        }
      }
    }

    // Find matching compost items by size
    for (const item of compostItems) {
      if (item.size === defaults.compost_size) {
        const cost = getFairCost(item);
        if (cost !== null) {
          compostAssignments.push({
            item_id: item.id,
            description: item.description,
            size: item.size,
            cost: cost,
            start_date: item.start_date,
            end_date: item.end_date,
          });
        }
      }
    }

    // Find matching recycle items by size
    for (const item of recycleItems) {
      if (item.size === defaults.recycle_size) {
        const cost = getFairCost(item);
        if (cost !== null) {
          recycleAssignments.push({
            item_id: item.id,
            description: item.description,
            size: item.size,
            cost: cost,
            start_date: item.start_date,
            end_date: item.end_date,
          });
        }
      }
    }

    // Calculate totals
    const garbageTotal = round(
      garbageAssignments.reduce((sum, a) => sum + a.cost, 0)
    );
    const compostTotal = round(
      compostAssignments.reduce((sum, a) => sum + a.cost, 0)
    );
    const recycleTotal = round(
      recycleAssignments.reduce((sum, a) => sum + a.cost, 0)
    );

    assignments.set(unit.id, {
      unit_id: unit.id,
      garbage_items: garbageAssignments,
      compost_items: compostAssignments,
      recycle_items: recycleAssignments,
      garbage_total: garbageTotal,
      compost_total: compostTotal,
      recycle_total: recycleTotal,
      total: round(garbageTotal + compostTotal + recycleTotal),
      auto_assigned: true,
    });
  }

  return assignments;
}

/**
 * Validate solid waste assignments against the bill.
 */
export function validateSolidWasteAssignments(
  bill: Bill,
  units: Unit[],
  assignments: SolidWasteAssignment[]
): SolidWasteValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const billTotal = getSolidWasteTotal(bill);
  const items = parseSolidWasteItems(bill);

  // Calculate assigned total (sum of all unit totals after rounding)
  const assignedTotal = round(
    assignments.reduce((sum, a) => sum + a.total, 0)
  );

  // Check if each unit has all three service types
  let unitsComplete = true;
  for (const unit of units) {
    const assignment = assignments.find((a) => a.unit_id === unit.id);
    if (!assignment) {
      errors.push(`${unit.name} has no solid waste assignment`);
      unitsComplete = false;
      continue;
    }

    // Check each service type - a unit should have at least one of each
    // (unless the bill doesn't include that service)
    const hasGarbage = assignment.garbage_items.length > 0;
    const hasCompost = assignment.compost_items.length > 0;
    const hasRecycle = assignment.recycle_items.length > 0;

    const billHasGarbage = items.some((i) => i.service_type === "Garbage");
    const billHasCompost = items.some((i) => i.service_type === "Food/Yard Waste");
    const billHasRecycle = items.some((i) => i.service_type === "Recycle");

    // Missing garbage/compost are warnings, not blockers
    // The total mismatch check will catch any real billing issues
    if (billHasGarbage && !hasGarbage) {
      warnings.push(`${unit.name} has no garbage assigned`);
      unitsComplete = false;
    }
    if (billHasCompost && !hasCompost) {
      warnings.push(`${unit.name} has no compost assigned`);
      unitsComplete = false;
    }
    if (billHasRecycle && !hasRecycle) {
      warnings.push(`${unit.name} has no recycle assigned (usually free)`);
      // Don't set unitsComplete = false for recycle as it's often $0
    }
  }

  // Check if item counts match
  const itemUsage = new Map<string, number>();
  for (const assignment of assignments) {
    for (const item of [
      ...assignment.garbage_items,
      ...assignment.compost_items,
      ...assignment.recycle_items,
    ]) {
      itemUsage.set(item.item_id, (itemUsage.get(item.item_id) || 0) + 1);
    }
  }

  for (const item of items) {
    const used = itemUsage.get(item.id) || 0;
    if (used < item.count) {
      errors.push(
        `${item.description}: only ${used}/${item.count} assigned`
      );
    } else if (used > item.count) {
      errors.push(
        `${item.description}: over-assigned ${used}/${item.count}`
      );
    }
  }

  // Check if totals match (after rounding)
  const totalsMatch = Math.abs(billTotal - assignedTotal) < 0.02; // Allow 2 cent tolerance

  if (!totalsMatch) {
    errors.push(
      `Total mismatch: Bill shows $${billTotal.toFixed(2)}, assigned $${assignedTotal.toFixed(2)}`
    );
  }

  return {
    is_valid: errors.length === 0,
    errors,
    warnings,
    bill_total: billTotal,
    assigned_total: assignedTotal,
    units_complete: unitsComplete,
    totals_match: totalsMatch,
  };
}

/**
 * Validate that all unit invoice totals (after rounding) sum to the bill total.
 */
export function validateBillTotals(
  bill: Bill,
  invoices: CalculatedInvoice[]
): BillTotalsValidation {
  const errors: string[] = [];
  const billTotal = bill.total_amount;

  // Sum all invoice amounts (each already rounded to 2 decimal places)
  const calculatedTotal = round(
    invoices.reduce((sum, inv) => sum + inv.amount, 0)
  );

  const difference = round(Math.abs(billTotal - calculatedTotal));
  const isValid = difference < 0.02; // Allow 2 cent tolerance for rounding

  if (!isValid) {
    errors.push(
      `Invoice totals ($${calculatedTotal.toFixed(2)}) do not match bill total ($${billTotal.toFixed(2)})`
    );
  }

  return {
    is_valid: isValid,
    bill_total: billTotal,
    calculated_total: calculatedTotal,
    difference,
    errors,
  };
}

/**
 * Calculate invoices including solid waste from assignments.
 * Applies final rounding adjustment to ensure totals match the bill exactly.
 */
export function calculateInvoicesWithSolidWaste(
  bill: Bill,
  units: Unit[],
  readings: Reading[],
  adjustments: Adjustment[],
  solidWasteAssignments: SolidWasteAssignment[]
): CalculatedInvoice[] {
  // Get base invoices without solid waste
  const baseInvoices = calculateInvoices(bill, units, readings, adjustments);

  // Add solid waste charges to each invoice
  const invoicesWithSolidWaste = baseInvoices.map((invoice) => {
    const swa = solidWasteAssignments.find((a) => a.unit_id === invoice.unit_id);
    if (!swa) return invoice;

    const newLineItems = [...invoice.line_items];

    // Add garbage charges
    if (swa.garbage_total > 0) {
      const garbageDesc =
        swa.garbage_items.length === 1
          ? swa.garbage_items[0].description
          : `Garbage (${swa.garbage_items.length} periods)`;
      newLineItems.push({
        description: garbageDesc,
        amount: swa.garbage_total,
        category: "solid_waste",
      });
    }

    // Add compost charges
    if (swa.compost_total > 0) {
      const compostDesc =
        swa.compost_items.length === 1
          ? swa.compost_items[0].description
          : `Food/Yard Waste (${swa.compost_items.length} periods)`;
      newLineItems.push({
        description: compostDesc,
        amount: swa.compost_total,
        category: "solid_waste",
      });
    }

    // Add recycle charges (usually $0 but include for completeness)
    if (swa.recycle_total > 0) {
      const recycleDesc =
        swa.recycle_items.length === 1
          ? swa.recycle_items[0].description
          : `Recycle (${swa.recycle_items.length} periods)`;
      newLineItems.push({
        description: recycleDesc,
        amount: swa.recycle_total,
        category: "solid_waste",
      });
    }

    const newAmount = round(invoice.amount + swa.total);

    return {
      ...invoice,
      amount: newAmount,
      line_items: newLineItems,
    };
  });

  // Round invoice amounts fairly to cents, ensuring they sum to bill total
  // (only if unrounded amounts match - validation catches real mismatches)
  const unroundedAmounts = invoicesWithSolidWaste.map(inv => inv.amount);
  const roundedAmounts = roundToTotal(unroundedAmounts, bill.total_amount);

  return invoicesWithSolidWaste.map((invoice, idx) => ({
    ...invoice,
    amount: roundedAmounts[idx],
  }));
}

/**
 * Check if a bill is ready for approval based on all validations.
 */
export function isBillReadyForApproval(
  bill: Bill,
  units: Unit[],
  readings: Reading[],
  adjustments: Adjustment[],
  solidWasteAssignments: SolidWasteAssignment[]
): { ready: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Check all units have readings
  for (const unit of units) {
    const hasReading = readings.some((r) => r.unit_id === unit.id && r.reading > 0);
    if (!hasReading) {
      errors.push(`${unit.name} has no water reading`);
    }
  }

  // 2. Check all adjustments are assigned (if any)
  for (const adj of adjustments) {
    if (!adj.assigned_unit_ids || adj.assigned_unit_ids.length === 0) {
      errors.push(`Adjustment "${adj.description}" is not assigned to any unit`);
    }
  }

  // 3. Validate solid waste assignments
  const swValidation = validateSolidWasteAssignments(
    bill,
    units,
    solidWasteAssignments
  );
  if (!swValidation.is_valid) {
    errors.push(...swValidation.errors);
  }
  // Collect warnings from solid waste validation (e.g., missing garbage/compost)
  warnings.push(...swValidation.warnings);

  // 4. Validate totals
  const invoices = calculateInvoicesWithSolidWaste(
    bill,
    units,
    readings,
    adjustments,
    solidWasteAssignments
  );
  const totalsValidation = validateBillTotals(bill, invoices);
  if (!totalsValidation.is_valid) {
    errors.push(...totalsValidation.errors);
  }

  return {
    ready: errors.length === 0,
    errors,
    warnings,
  };
}
