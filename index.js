const core = require('@actions/core');
const { BedrockAgentRuntimeWrapper } = require('./bedrock-wrapper');

// Initialize Bedrock Agent client
const agentWrapper = new BedrockAgentRuntimeWrapper();

async function main() {
    try {
        core.info(`[${getTimestamp()}] Starting GitHub Action`);

        // Parse inputs from the GitHub Action workflow
        const actionPrompt = core.getInput('action_prompt').trim();
        const agentId = core.getInput('agent_id').trim();
        const agentAliasId = core.getInput('agent_alias_id').trim();
        const memoryId = core.getInput('memory_id').trim() || undefined;
        const debug = core.getBooleanInput('debug');

        // Generate a simple session ID based on timestamp
        const sessionId = `session-${Date.now()}`;

        if (debug) {
            core.info(`[${getTimestamp()}] Using prompt: ${actionPrompt}`);
            core.info(`[${getTimestamp()}] Session ID: ${sessionId}`);
        }

        // Invoke the Bedrock Agent with the prompt
        core.info(`[${getTimestamp()}] Invoking Bedrock Agent`);
        const agentResponse = await agentWrapper.invokeAgent(agentId, agentAliasId, sessionId, actionPrompt, memoryId);

        // Output the response
        console.info(`## Bedrock Agent Response\n\n${agentResponse}`);
        core.info(`[${getTimestamp()}] Action completed successfully`);

    } catch (error) {
        core.setFailed(`[${getTimestamp()}] Error: ${error.message}`);
    }
}

// Get the current timestamp in ISO format
function getTimestamp() {
    return new Date().toISOString();
}

// Start the GitHub Action
main();
