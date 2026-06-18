// Map a Carbon Intensity API region id (1–14 DNO regions) to its Octopus / GSP
// group letter (A–P), needed for Agile tariff lookups (SPEC §2.2). National
// (GB, id 18) has no single tariff region, so price defaults to a representative
// region, clearly labelled.

const REGION_TO_GSP: Record<number, string> = {
  1: 'P', // North Scotland
  2: 'N', // South Scotland
  3: 'G', // North West England
  4: 'F', // North East England
  5: 'M', // Yorkshire
  6: 'D', // North Wales & Merseyside
  7: 'K', // South Wales
  8: 'E', // West Midlands
  9: 'B', // East Midlands
  10: 'A', // East England
  11: 'L', // South West England
  12: 'H', // South England
  13: 'C', // London
  14: 'J', // South East England
};

// Default tariff region used when the view is national GB (id 18).
export const DEFAULT_GSP_REGION_ID = 13; // London

export function gspForRegion(regionId: number): { letter: string; regionId: number } {
  const effectiveId = REGION_TO_GSP[regionId] ? regionId : DEFAULT_GSP_REGION_ID;
  return { letter: REGION_TO_GSP[effectiveId], regionId: effectiveId };
}

const REGION_LABEL: Record<number, string> = {
  1: 'North Scotland',
  2: 'South Scotland',
  3: 'North West England',
  4: 'North East England',
  5: 'Yorkshire',
  6: 'North Wales & Merseyside',
  7: 'South Wales',
  8: 'West Midlands',
  9: 'East Midlands',
  10: 'East England',
  11: 'South West England',
  12: 'South England',
  13: 'London',
  14: 'South East England',
};

export function gspRegionLabel(regionId: number): string {
  return REGION_LABEL[regionId] ?? `Region ${regionId}`;
}
