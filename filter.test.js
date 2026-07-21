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
            process.env.WHITELIST_TECHNOLOGIES = '';
            process.env.WHITELIST_ROLES = '';
            process.env.BLACKLIST_ROLES = '';
            process.env.BLACKLIST_TECHNOLOGIES = '';
        });

        it('should return true if no whitelists or blacklists are provided', () => {
            const result = isJobRelevantKeywords('Any job description');
            expect(result.matched).toBe(true);
        });

        it('should return true if text matches both a technology and a role', () => {
            process.env.WHITELIST_TECHNOLOGIES = 'react, python';
            process.env.WHITELIST_ROLES = 'developer, engineer';
            const result = isJobRelevantKeywords('Looking for a Python developer');
            expect(result.matched).toBe(true);
            expect(result.reason).toContain('python');
            expect(result.reason).toContain('developer');
        });

        it('should return false if text matches a technology but NOT a role', () => {
            process.env.WHITELIST_TECHNOLOGIES = 'react, python';
            process.env.WHITELIST_ROLES = 'developer, engineer';
            const result = isJobRelevantKeywords('Python workshop for beginners');
            expect(result.matched).toBe(false);
            expect(result.reason).toContain('No role matched');
        });

        it('should return false if text matches a role but NOT a technology', () => {
            process.env.WHITELIST_TECHNOLOGIES = 'react, python';
            process.env.WHITELIST_ROLES = 'developer, engineer';
            const result = isJobRelevantKeywords('Looking for a hardware engineer');
            expect(result.matched).toBe(false);
            expect(result.reason).toContain('No technology matched');
        });

        it('should reject if BLACKLIST_ROLES matches the job title', () => {
            process.env.BLACKLIST_ROLES = 'team lead';
            const result = isJobRelevantKeywords('*Team Lead Node.js* / Acme\n\nWe use React and Node.js');
            expect(result.matched).toBe(false);
            expect(result.reason).toContain('team lead');
        });

        it('should NOT reject if BLACKLIST_ROLES word appears only in description (not title)', () => {
            process.env.BLACKLIST_ROLES = 'team lead';
            process.env.WHITELIST_TECHNOLOGIES = 'react';
            process.env.WHITELIST_ROLES = 'engineer';
            // "team lead" appears in description only, not in the title
            const result = isJobRelevantKeywords('*Senior Backend Engineer* / Acme\n\nYou will work alongside team leads. We use React.');
            expect(result.matched).toBe(true);
        });

        it('should reject if BLACKLIST_TECHNOLOGIES appears anywhere in description', () => {
            process.env.BLACKLIST_TECHNOLOGIES = 'cobol';
            process.env.WHITELIST_TECHNOLOGIES = 'java';
            process.env.WHITELIST_ROLES = 'developer';
            const result = isJobRelevantKeywords('*Java Developer* / Acme\n\nExperience with Java and COBOL required.');
            expect(result.matched).toBe(false);
            expect(result.reason).toContain('cobol');
        });

        it('should return false if text matches a blacklist keyword (with no whitelist)', () => {
            process.env.BLACKLIST_TECHNOLOGIES = 'cobol';
            const result = isJobRelevantKeywords('We need a COBOL developer');
            expect(result.matched).toBe(false);
        });
        
        it('handles case insensitivity and spacing', () => {
            process.env.WHITELIST_TECHNOLOGIES = '  ReAcT  ,  NoDeJs ';
            process.env.WHITELIST_ROLES = 'developer';
            const result = isJobRelevantKeywords('looking for a react developer');
            expect(result.matched).toBe(true);
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
            process.env.WHITELIST_TECHNOLOGIES = '';
            process.env.WHITELIST_ROLES = '';
            process.env.BLACKLIST_ROLES = '';
            process.env.BLACKLIST_TECHNOLOGIES = '';

            // Should pass (exceeds nothing, no experience specified)
            expect((await isJobRelevant('Looking for a React developer')).matched).toBe(true);

            // Should pass (requires 3 years, which is <= 5)
            expect((await isJobRelevant('Looking for a React developer with 3 years experience')).matched).toBe(true);

            // Should be filtered out (requires 8 years, which is > 5)
            expect((await isJobRelevant('Looking for a React developer with 8+ years experience')).matched).toBe(false);
        });
    });
});
