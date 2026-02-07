import { describe, it, expect } from 'vitest';
import { inferTableFromGeojsonAndFilename } from '../app/scripts/fileManager.js';

describe('fileManager.inferTableFromGeojsonAndFilename', () => {
  it('infers table from geojson.properties.table', () => {
    const geo = { properties: { table: 'High' } };
    expect(inferTableFromGeojsonAndFilename(geo, null)).toBe('high');
  });

  it('infers table from filename when properties.table missing', () => {
    const geo = { properties: {} };
    expect(inferTableFromGeojsonAndFilename(geo, 'My_Elementary_map.geojson')).toBe('elementary');
    expect(inferTableFromGeojsonAndFilename(null, 'middle_school.geojson')).toBe('middle');
  });

  it('returns null when nothing matches', () => {
    expect(inferTableFromGeojsonAndFilename({}, 'something_else.json')).toBe(null);
  });
});
