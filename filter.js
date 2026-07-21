const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * Checks if a job description matches using the Gemini AI API.
 */
async function isJobRelevantAI(jobDescription, criteria) {
    if (!jobDescription || !criteria) return false;

    const prompt = `
You are a job filtering assistant. 
Does the following job description match these criteria?
Criteria: "${criteria}"

Job Description:
"""
${jobDescription}
"""

Reply with ONLY "YES" if it is relevant and a good match, or "NO" if it is not relevant. Do not include any other text.
`;

    try {
        const apiCall = ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
        });

        const timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Gemini API call timed out after 15 seconds')), 15000)
        );

        const response = await Promise.race([apiCall, timeout]);

        const text = response.text.trim().toUpperCase();
        return text.includes('YES');
    } catch (error) {
        throw error;
    }
}

/**
 * Checks if a job description matches using basic keyword matching.
 * Returns { matched: boolean, reason: string }
 */
function isJobRelevantKeywords(jobDescription) {
    if (!jobDescription) return { matched: false, reason: 'Empty job description' };

    const text = jobDescription.toLowerCase();

    // Parse keywords from environment variables
    const getWords = (envVar) => 
        (process.env[envVar] || '')
        .split(',')
        .map(w => w.trim().toLowerCase())
        .filter(w => w.length > 0);

    const technologies = getWords('WHITELIST_TECHNOLOGIES');
    const roles = getWords('WHITELIST_ROLES');
    const blacklist = getWords('BLACKLIST_KEYWORDS');

    // 1. Check blacklist first. If ANY blacklisted word is present, reject immediately.
    for (const word of blacklist) {
        if (text.includes(word)) {
            return { matched: false, reason: `Blacklisted keyword matched: "${word}"` };
        }
    }

    // 2. Check technologies. If provided, AT LEAST ONE must be present.
    if (technologies.length > 0) {
        const matchedTech = technologies.find(word => text.includes(word));
        if (!matchedTech) {
            return { matched: false, reason: `No technology matched (need one of: ${technologies.join(', ')})` };
        }
    }

    // 3. Check roles. If provided, AT LEAST ONE must be present.
    if (roles.length > 0) {
        const matchedRole = roles.find(word => text.includes(word));
        if (!matchedRole) {
            return { matched: false, reason: `No role matched (need one of: ${roles.join(', ')})` };
        }
    }

    // Build a summary of what matched
    const matchedTechs = technologies.filter(w => text.includes(w));
    const matchedRoles = roles.filter(w => text.includes(w));
    const reason = [
        matchedTechs.length > 0 ? `Tech: ${matchedTechs.join(', ')}` : '',
        matchedRoles.length > 0 ? `Role: ${matchedRoles.join(', ')}` : '',
    ].filter(Boolean).join(' | ');

    return { matched: true, reason: reason || 'Passed all filters' };
}

function extractYearsOfExperience(text) {
    if (!text) return 0;
    const textLower = text.toLowerCase();
    
    const englishRegex = /\b(?:minimum\s+)?(\d+)\s*(?:\+|–|-|to)?\s*(\d+)?\s*years?\b/gi;
    // Unicode-safe boundary helper instead of \b for Hebrew regex
    const hebrewRegex = /(?:^|[^0-9])(?:מעל\s+)?(\d+)\s*(?:\+|–|-|עד)?\s*(\d+)?\s*(?:שנים|שנות)/gi;
    
    let maxFound = 0;
    let match;
    
    const containsWholeWord = (str, word) => {
        const escapedWord = word.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const regex = new RegExp(`(?<![a-zA-Z0-9_\\u0590-\\u05fe])${escapedWord}(?![a-zA-Z0-9_\\u0590-\\u05fe])`, 'i');
        return regex.test(str);
    };

    const isRequirement = (matchedText, fullText) => {
        if (matchedText.includes('+') || matchedText.includes('-') || matchedText.includes('–') || matchedText.includes('to') || matchedText.includes('עד')) {
            return true;
        }
        const index = fullText.indexOf(matchedText);
        if (index === -1) return false;
        const contextStart = Math.max(0, index - 40);
        const contextEnd = Math.min(fullText.length, index + matchedText.length + 40);
        const context = fullText.substring(contextStart, contextEnd);
        
        const reqKeywords = ['experience', 'hands-on', 'development', 'developer', 'engineer', 'working', 'programming', 'coding', 'as', 'in', 'ניסיון', 'פיתוח', 'עבודה', 'כמפתח', 'כמתכנת', 'מינימום', 'לפחות', 'at least', 'minimum'];
        return reqKeywords.some(kw => containsWholeWord(context, kw));
    };
    
    while ((match = englishRegex.exec(textLower)) !== null) {
        if (isRequirement(match[0], textLower)) {
            const num1 = parseInt(match[1], 10);
            const num2 = match[2] ? parseInt(match[2], 10) : null;
            if (!isNaN(num1)) maxFound = Math.max(maxFound, num1);
            if (num2 && !isNaN(num2)) maxFound = Math.max(maxFound, num2);
        }
    }
    
    while ((match = hebrewRegex.exec(textLower)) !== null) {
        // match[0] starts with the boundary character if matching [^0-9], strip it for index matching
        let matchedStr = match[0];
        if (matchedStr && /^[^\d]/.test(matchedStr)) {
            matchedStr = matchedStr.substring(1);
        }
        if (isRequirement(matchedStr, textLower)) {
            const num1 = parseInt(match[1], 10);
            const num2 = match[2] ? parseInt(match[2], 10) : null;
            if (!isNaN(num1)) maxFound = Math.max(maxFound, num1);
            if (num2 && !isNaN(num2)) maxFound = Math.max(maxFound, num2);
        }
    }
    
    return maxFound;
}

/**
 * Master filtering function that routes to AI or Keyword logic based on config.
 * Returns { matched: boolean, reason: string }
 */
async function isJobRelevant(jobDescription) {
    const maxYearsEnv = process.env.MAX_YEARS_EXPERIENCE ? parseInt(process.env.MAX_YEARS_EXPERIENCE, 10) : null;
    if (maxYearsEnv) {
        const years = extractYearsOfExperience(jobDescription);
        if (years > maxYearsEnv) {
            const reason = `Requires ${years} years of experience (max is ${maxYearsEnv})`;
            console.log(`🚫 FILTER OUT: ${reason}.`);
            return { matched: false, reason };
        }
    }

    const mode = (process.env.FILTER_MODE || 'ai').toLowerCase();

    if (mode === 'keywords') {
        return isJobRelevantKeywords(jobDescription);
    } else {
        const criteria = process.env.JOB_CRITERIA;
        const matched = await isJobRelevantAI(jobDescription, criteria);
        return { matched, reason: matched ? 'AI classified as relevant' : 'AI classified as not relevant' };
    }
}

module.exports = { isJobRelevant, isJobRelevantAI, isJobRelevantKeywords, extractYearsOfExperience };
