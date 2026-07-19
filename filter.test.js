const { isJobRelevant, isJobRelevantAI, isJobRelevantKeywords } = require('./filter');
const { GoogleGenAI } = require('@google/genai');

// Mock the GoogleGenAI module
jest.mock('@google/genai');

describe('Job Filter Logic', () => {

    describe('AI Filter Mode', () => {
        let mockGenerateContent;

        beforeEach(() => {
            jest.clearAllMocks();
            mockGenerateContent = jest.fn();
            GoogleGenAI.mockImplementation(() => ({
                models: { generateContent: mockGenerateContent }
            }));
            process.env.FILTER_MODE = 'ai';
        });

        it('should return false if job description is missing', async () => {
            const result = await isJobRelevantAI(null, 'React Developer');
            expect(result).toBe(false);
        });

        it('should return true when Gemini responds with YES', async () => {
            mockGenerateContent.mockResolvedValue({ text: 'YES' });
            jest.isolateModules(() => {
                const { isJobRelevantAI: isRelevantMocked } = require('./filter');
                return isRelevantMocked('We need a remote React developer', 'Remote React Developer').then(result => {
                    expect(result).toBe(true);
                });
            });
        });

        it('should return false when Gemini responds with NO', async () => {
            mockGenerateContent.mockResolvedValue({ text: 'NO' });
            jest.isolateModules(() => {
                const { isJobRelevantAI: isRelevantMocked } = require('./filter');
                return isRelevantMocked('We need a local Python developer', 'Remote React Developer').then(result => {
                    expect(result).toBe(false);
                });
            });
        });
    });

    describe('Keyword Filter Mode', () => {
        
        beforeEach(() => {
            process.env.FILTER_MODE = 'keywords';
            process.env.WHITELIST_KEYWORDS = '';
            process.env.BLACKLIST_KEYWORDS = '';
        });

        it('should return true if no whitelist and no blacklist are provided', async () => {
            const result = await isJobRelevantKeywords('Any job description');
            expect(result).toBe(true);
        });

        it('should return true if text matches a whitelist keyword', async () => {
            process.env.WHITELIST_KEYWORDS = 'react, python';
            const result = await isJobRelevantKeywords('Looking for a Python developer');
            expect(result).toBe(true);
        });

        it('should return false if text does NOT match any whitelist keyword', async () => {
            process.env.WHITELIST_KEYWORDS = 'react, python';
            const result = await isJobRelevantKeywords('Looking for a Java developer');
            expect(result).toBe(false);
        });

        it('should return false if text matches a blacklist keyword (even if whitelist matches)', async () => {
            process.env.WHITELIST_KEYWORDS = 'react';
            process.env.BLACKLIST_KEYWORDS = 'senior';
            const result = await isJobRelevantKeywords('Looking for a Senior React developer');
            expect(result).toBe(false);
        });

        it('should return false if text matches a blacklist keyword (with no whitelist)', async () => {
            process.env.BLACKLIST_KEYWORDS = 'office, hybrid';
            const result = await isJobRelevantKeywords('We need an office worker');
            expect(result).toBe(false);
        });
        
        it('handles case insensitivity and spacing', async () => {
            process.env.WHITELIST_KEYWORDS = '  ReAcT  ,  NoDeJs ';
            const result = await isJobRelevantKeywords('looking for a react developer');
            expect(result).toBe(true);
        });
    });

    describe('Years of Experience Filter', () => {
        const { extractYearsOfExperience } = require('./filter');

        beforeEach(() => {
            delete process.env.MAX_YEARS_EXPERIENCE;
        });

        it('extracts correct years of experience from English strings', () => {
            expect(extractYearsOfExperience('Looking for 5+ years of experience')).toBe(5);
            expect(extractYearsOfExperience('Requires 5-7 years of hands-on development')).toBe(7);
            expect(extractYearsOfExperience('Minimum 3 years working as a developer')).toBe(3);
            expect(extractYearsOfExperience('2+ years as a backend engineer')).toBe(2);
        });

        it('extracts correct years of experience from Hebrew strings', () => {
            expect(extractYearsOfExperience('דרוש מפתח עם 3+ שנות ניסיון')).toBe(3);
            expect(extractYearsOfExperience('ניסיון של 5 שנים כארכיטקט')).toBe(5);
            expect(extractYearsOfExperience('לפחות 2 שנות ניסיון בפיתוח')).toBe(2);
        });

        it('ignores general time references that are not requirements', () => {
            expect(extractYearsOfExperience('Our company was founded 10 years ago')).toBe(0);
        });

        it('filters out jobs exceeding MAX_YEARS_EXPERIENCE', async () => {
            process.env.MAX_YEARS_EXPERIENCE = '5';
            process.env.FILTER_MODE = 'keywords';
            process.env.WHITELIST_KEYWORDS = '';
            process.env.BLACKLIST_KEYWORDS = '';

            // Should pass (exceeds nothing, no experience specified)
            expect(await isJobRelevant('Looking for a React developer')).toBe(true);

            // Should pass (requires 3 years, which is <= 5)
            expect(await isJobRelevant('Looking for a React developer with 3 years experience')).toBe(true);

            // Should be filtered out (requires 8 years, which is > 5)
            expect(await isJobRelevant('Looking for a React developer with 8+ years experience')).toBe(false);
        });
    });
});
