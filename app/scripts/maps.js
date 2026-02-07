export const baseMaps = [
    { title: "SRCS Elementary - Blank", table: "elementary", url: "maps/elementary_blocks.geojson" },
    { title: "SRCS Secondary - Blank", table: "secondary", url: "maps/secondary_blocks.geojson" },
];

export const proposalMaps = [
    // { title: 'Proposal - Elementary A', table: 'elementary', url: 'proposals/proposal_elementary_A.geojson' },
];

// Combined export so callers can import a single object containing all map options.
export const baseMapOptions = [...baseMaps, ...proposalMaps];
