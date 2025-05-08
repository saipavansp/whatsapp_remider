const { GoogleGenerativeAI } = require("@google/generative-ai");
const config = require("./config");

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);

/**
 * Validate response against user query and context
 * @param {string} userQuery - Original user question
 * @param {Array} retrievedReminders - Reminders retrieved from database
 * @param {Array} conversationHistory - Recent conversation history
 * @param {string} proposedResponse - The response we're about to send
 * @returns {Promise<Object>} - Validation result with corrected response if needed
 */
async function validateResponse(
  userQuery,
  retrievedReminders,
  conversationHistory,
  proposedResponse,
) {
  try {
    // Perform a quick check for date patterns in the query
    const datePattern =
      /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|may|june|july|august|september|october|november|december)[\s,]+\d{1,2}(st|nd|rd|th)?\b/i;
    const dateMatch = userQuery.toLowerCase().match(datePattern);

    // Determine if this is a date-specific query
    const likelyDateQuery =
      dateMatch ||
      userQuery.toLowerCase().includes("tomorrow") ||
      userQuery.toLowerCase().includes("yesterday") ||
      /\bon\s+\w+day\b/i.test(userQuery); // "on Monday", "on Tuesday", etc.

    // Create a comprehensive prompt with all context
    const prompt = `
      As an intelligent assistant, verify if this response correctly answers the user's query.

      USER QUERY: "${userQuery}"

      CONVERSATION HISTORY (last 3 messages):
      ${conversationHistory
        .slice(-3)
        .map((msg) => `${msg.role}: ${msg.content}`)
        .join("\n")}

      RETRIEVED DATA (reminders):
      ${JSON.stringify(retrievedReminders, null, 2)}

      PROPOSED RESPONSE:
      "${proposedResponse}"

      ${likelyDateQuery ? "⚠️ IMPORTANT: This query appears to be asking about a SPECIFIC DATE. Verify that the response addresses the EXACT date mentioned in the query, not today's date." : ""}

      Does this response correctly answer the user's query? If not, provide a corrected response.

      Consider these critical issues:
      1. DATE MISMATCH CHECK: If the query asks about a specific date ("May 10th", "tomorrow", "next Monday"), does the response EXACTLY match that date? If not, this is a critical error.
      2. NO EVENTS CASE: If there are no events for the requested date, does the response clearly say "You have no reminders scheduled for [the specific date]"?
      3. TIME PERIOD MATCH: Is the response showing events for the exact time period requested (today, tomorrow, next week, specific date)?
      4. COMPLETENESS: Are all relevant reminders from the retrieved data included in the response?
      5. CATEGORY MATCH: If a specific category was requested, is the filtering correct?

      Return ONLY a valid JSON with these fields:
      {
        "isCorrect": boolean indicating if the proposed response is appropriate,
        "correctedResponse": improved response if the original is incorrect, or null if it's already correct,
        "explanation": brief explanation of your reasoning
      }
    `;

    // Get LLM validation
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    // Parse response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log(
        "Failed to parse validation response, defaulting to accepting original response",
      );

      // If this is a date query and we failed validation, do a basic check
      if (likelyDateQuery) {
        // Extract date from query (very basic)
        const extractedDate = dateMatch ? dateMatch[0] : null;

        // Check if date is mentioned in response
        if (
          extractedDate &&
          !proposedResponse.toLowerCase().includes(extractedDate.toLowerCase())
        ) {
          console.log(
            `Date mismatch detected: Query mentions "${extractedDate}" but response doesn't include it`,
          );

          // Fallback correction for common case of showing today's events
          if (
            proposedResponse.toLowerCase().includes("today") &&
            !userQuery.toLowerCase().includes("today")
          ) {
            const correctedResponse = `You have no reminders scheduled for ${extractedDate}.`;
            return {
              isCorrect: false,
              correctedResponse: correctedResponse,
              explanation:
                "Fallback correction: Date mentioned in query not found in response",
            };
          }
        }
      }

      return {
        isCorrect: true,
        correctedResponse: null,
        explanation: "Failed to parse validation result",
      };
    }

    const validationResult = JSON.parse(jsonMatch[0]);

    // Log the validation result for debugging/analytics
    console.log(
      `Response validation: isCorrect=${validationResult.isCorrect}, explanation=${validationResult.explanation}`,
    );

    return validationResult;
  } catch (error) {
    console.error("Error validating response:", error);
    // Default to accepting the original response if validation fails
    return {
      isCorrect: true,
      correctedResponse: null,
      explanation: "Validation error, using original response",
    };
  }
}

module.exports = {
  validateResponse,
};
