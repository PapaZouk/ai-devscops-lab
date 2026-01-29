import { jest, describe, it, expect } from '@jest/globals';
import axios from 'axios';
import { fetchInternalMetadata } from '../src/index';

describe('Simple Regression Test', () => {
    it('should merge data correctly', async () => {
        const mockData = { id: 1, title: 'Test Title' };
        
        const spy = jest.spyOn(axios, 'get').mockResolvedValue({ 
            data: mockData 
        } as any);

        const result = await fetchInternalMetadata();

        if (!result) {
            throw new Error("Internal metadata fetch failed");
        }

        expect(result.service).toBe('aws-monitor');
        expect(result.metadata.id).toBe(1);

        spy.mockRestore();
    });
});