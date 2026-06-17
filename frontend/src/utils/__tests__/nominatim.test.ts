import { describe, it, expect } from 'vitest';
import { parseCoordInput } from '../nominatim';

describe('parseCoordInput', () => {
  it('parses comma-separated lat,lon', () => {
    expect(parseCoordInput('54.3, 10.12')).toEqual([54.3, 10.12]);
  });

  it('parses space-separated lat lon', () => {
    expect(parseCoordInput('54.3 10.12')).toEqual([54.3, 10.12]);
  });

  it('handles negative coordinates', () => {
    expect(parseCoordInput('-33.8688, 151.2093')).toEqual([-33.8688, 151.2093]);
    expect(parseCoordInput('40.7128, -74.0060')).toEqual([40.7128, -74.006]);
  });

  it('handles integer coordinates', () => {
    expect(parseCoordInput('0, 0')).toEqual([0, 0]);
    expect(parseCoordInput('45, 90')).toEqual([45, 90]);
  });

  it('trims whitespace', () => {
    expect(parseCoordInput('  54.3 , 10.12  ')).toEqual([54.3, 10.12]);
  });

  it('returns null for invalid input', () => {
    expect(parseCoordInput('hello')).toBeNull();
    expect(parseCoordInput('')).toBeNull();
    expect(parseCoordInput('abc, def')).toBeNull();
  });

  it('returns null for out-of-range latitude', () => {
    expect(parseCoordInput('91, 10')).toBeNull();
    expect(parseCoordInput('-91, 10')).toBeNull();
  });

  it('returns null for out-of-range longitude', () => {
    expect(parseCoordInput('54, 181')).toBeNull();
    expect(parseCoordInput('54, -181')).toBeNull();
  });

  it('handles edge coordinates', () => {
    expect(parseCoordInput('90, 180')).toEqual([90, 180]);
    expect(parseCoordInput('-90, -180')).toEqual([-90, -180]);
  });
});
