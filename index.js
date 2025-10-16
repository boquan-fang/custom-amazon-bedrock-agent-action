const core = require('@actions/core');
const github = require('@actions/github');
const minimatch = require('minimatch');
const { BedrockAgentRuntimeWrapper } = require('./bedrock-wrapper');
const fs = require('fs');
const path = require('path');

// Initialize GitHub and Bedrock Agent clients
const octokit = github.getOctokit(process.env.GITHUB_TOKEN);
const agentWrapper = new BedrockAgentRuntimeWrapper();

async function main() {
    try {
        core.info(`[${getTimestamp()}] Starting GitHub Action`);

        // Ensure required environment variables are set
        const requiredEnvVars = ['GITHUB_TOKEN', 'GITHUB_REPOSITORY'];
        if (requiredEnvVars.some(varName => !process.env[varName])) {
            core.setFailed(`Error: Missing required environment variables: ${requiredEnvVars.join(', ')}.`);
            return;
        }

        // Extract payload from GitHub context
        const payload = github.context.payload;
        const eventName = github.context.eventName;

        // Parse inputs from the GitHub Action workflow
        const ignorePatterns = core.getInput('ignore_patterns')
            .split(',').map(pattern => pattern.trim()).filter(Boolean);

        const actionPrompt = core.getInput('action_prompt').trim();
        const agentId = core.getInput('agent_id').trim();
        const agentAliasId = core.getInput('agent_alias_id').trim();
        const debug = core.getBooleanInput('debug');
        const memoryId = core.getInput('memory_id').trim() || undefined;

        // Extract repository information
        const { GITHUB_REPOSITORY: githubRepository } = process.env;
        const [owner, repo] = githubRepository.split('/');

        let sessionId, changedFiles = [];

        if (eventName === 'workflow_dispatch') {
            // Handle workflow_dispatch event
            const workflowId = github.context.runId;
            sessionId = `workflow-${workflowId}`;
            core.info(`[${getTimestamp()}] Processing workflow_dispatch (ID: ${workflowId}) in repository ${owner}/${repo}`);
            
            // Get the default branch name to analyze repository files
            const { data: repoInfo } = await octokit.rest.repos.get({
                owner,
                repo
            });
            const defaultBranch = repoInfo.default_branch;
            
            // Get repository content from the default branch
            const { data: repoContents } = await octokit.rest.repos.getContent({
                owner,
                repo,
                path: '',
                ref: defaultBranch
            });
            
            // Simulate changedFiles structure for repository analysis
            changedFiles = repoContents.filter(item => item.type === 'file').map(file => ({
                filename: file.path,
                status: 'analyzed',
            }));
            
        } else if (eventName === 'schedule') {
            // Handle schedule event
            const scheduleId = new Date().toISOString().replace(/[^0-9]/g, '');
            sessionId = `schedule-${scheduleId}`;
            core.info(`[${getTimestamp()}] Processing scheduled event (ID: ${scheduleId}) in repository ${owner}/${repo}`);
            
            // Get the default branch name to analyze repository files
            const { data: repoInfo } = await octokit.rest.repos.get({
                owner,
                repo
            });
            const defaultBranch = repoInfo.default_branch;
            
            // Get repository content from the default branch
            const { data: repoContents } = await octokit.rest.repos.getContent({
                owner,
                repo,
                path: '',
                ref: defaultBranch
            });
            
            // Simulate changedFiles structure for repository analysis
            changedFiles = repoContents.filter(item => item.type === 'file').map(file => ({
                filename: file.path,
                status: 'analyzed',
            }));
            
        } else {
            core.setFailed(`Unsupported event type: ${eventName}. This action only supports workflow_dispatch and schedule events.`);
            return;
        }

        core.info(`[${getTimestamp()}] Retrieved ${changedFiles.length} changed files`);

        // Load patterns from .gitignore if it exists
        let gitignorePatterns = [];
        const gitignorePath = path.join(process.env.GITHUB_WORKSPACE, '.gitignore');
        if (fs.existsSync(gitignorePath)) {
            gitignorePatterns = fs.readFileSync(gitignorePath, 'utf-8')
                .split('\n').map(line => line.trim())
                .filter(line => line && !line.startsWith('#'));

            if (debug) {
                core.info(`[${getTimestamp()}] Loaded .gitignore patterns:\n${gitignorePatterns.join(', ')}`);
            }
        }

        // Combine ignore patterns from both the input and .gitignore
        const allIgnorePatterns = [...ignorePatterns, ...gitignorePatterns];

        // Initialize arrays to store relevant code and diffs
        const relevantCode = [];
        const relevantDiffs = [];
        await Promise.all(changedFiles.map(file => processFile(file, allIgnorePatterns, relevantCode, relevantDiffs, owner, repo, eventName)));

        // Check if there are any relevant code or diffs to analyze
        if (relevantDiffs.length === 0 && relevantCode.length === 0) {
            core.warning(`[${getTimestamp()}] No relevant files or diffs found for analysis.`);
            return;
        }

        // Prepare the prompt for the Bedrock Agent
        const diffsPrompt = `Changes:\n${relevantDiffs.join('')}`;
        const prompt = relevantCode.length
            ? `Content of Affected Files:\n${relevantCode.join('')}\nUse the files above to provide context on the changes made.\n${diffsPrompt}\n${actionPrompt}`
            : `${diffsPrompt}\n${actionPrompt}`;

        // Validate the prompt before proceeding
        if (typeof prompt !== 'string') {
            core.setFailed('Error: The generated prompt is not a valid string.');
            return;
        }

        if (debug) {
            core.info(`[${getTimestamp()}] Generated prompt for Bedrock Agent:\n${prompt}`);
        }

        // Invoke the Bedrock Agent with the generated prompt
        core.info(`[${getTimestamp()}] Invoking Bedrock Agent with session ID: ${sessionId} and memory ID: ${memoryId}`);
        const agentResponse = await agentWrapper.invokeAgent(agentId, agentAliasId, sessionId, prompt, memoryId);

        if (debug) {
            core.info(`[${getTimestamp()}] Bedrock Agent response:\n${agentResponse}`);
        }

        // Print analysis for workflow_dispatch and schedule events
        core.info(`[${getTimestamp()}] Printing analysis for ${eventName} event`);
        const analysisOutput = formatMarkdownAnalysis(agentResponse, eventName, relevantCode.length, relevantDiffs.length, changedFiles);
        console.info(analysisOutput);
        core.info(`[${getTimestamp()}] Analysis output printed to console`);
    } catch (error) {
        core.setFailed(`[${getTimestamp()}] Error: ${error.message}`);
    }
}


// Process each file for analysis
async function processFile(file, ignorePatterns, relevantCode, relevantDiffs, owner, repo, eventName) {
    const { filename, status } = file;

    // Only process files that don't match ignore patterns
    if (!ignorePatterns.some(pattern => minimatch(filename, pattern))) {
        // Attempt to fetch the file content for analysis
        try {
            const { data: fileContent } = await octokit.rest.repos.getContent({ owner, repo, path: filename });
            if (fileContent?.type === 'file') {
                const content = Buffer.from(fileContent.content, 'base64').toString('utf8');
                relevantCode.push(`Content of ${filename}\n\`\`\`\n${content}\n\`\`\`\n`);
                core.info(`[${getTimestamp()}] Added file content for analysis: ${filename} (Status: ${status})`);
            }
        } catch (error) {
            core.error(`[${getTimestamp()}] Error fetching content for file ${filename}: ${error.message}`);
        }

        // Add file information to the diffs list (no actual diff for workflow_dispatch and schedule)
        relevantDiffs.push(`File: ${filename} (Status: ${status})\n`);
    }
}

// Format the analysis output for events
function formatMarkdownAnalysis(response, eventType, filesAnalyzed, diffsAnalyzed, changedFiles) {
    const fileSummary = changedFiles
        .map(file => `- **${file.filename}**: ${file.status}`)
        .join('\n');

    const eventTypeDisplay = eventType === 'workflow_dispatch' ? 'Workflow Dispatch' : 'Scheduled Run';
    const timestamp = new Date().toISOString();

    return `## Analysis for ${eventTypeDisplay} (Time: ${timestamp})\n\n### Files Analyzed: ${filesAnalyzed}\n### Diffs Analyzed: ${diffsAnalyzed}\n\n### Files Processed:\n${fileSummary}\n\n${response}`;
}

// Get the current timestamp in ISO format
function getTimestamp() {
    return new Date().toISOString();
}

// Start the GitHub Action
main();
