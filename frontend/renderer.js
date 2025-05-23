const toggleButton = document.getElementById('toggleButton');
const statusText = document.getElementById('statusText');
const transcriptDisplay = document.getElementById('transcriptDisplay');
const cheatSheetDisplay = document.getElementById('cheatSheetDisplay');
const llmMonitorDisplay = document.getElementById('llmMonitorDisplay');
const logDisplay = document.getElementById('logDisplay');
const filterButtons = document.querySelectorAll('.filter-btn');
const videoTitleInput = document.getElementById('videoTitleInput');
const setVideoTitleBtn = document.getElementById('setVideoTitleBtn');

let isBackendRunning = false;
const cheatSheetEntities = new Map(); // Using a Map to store entities by name for quick lookup/update
const socket = io('http://127.0.0.1:5000'); // Connect to Flask-SocketIO backend
let currentFilter = 'all'; // State variable for current filter

// --- UI Update Functions ---
function updateToggleButton(running) {
    isBackendRunning = running;
    if (running) {
        toggleButton.classList.remove('off');
        toggleButton.classList.add('on');
        toggleButton.textContent = 'Turn Off';
        statusText.textContent = 'Listening and Processing...';
    } else {
        toggleButton.classList.remove('on');
        toggleButton.classList.add('off');
        toggleButton.textContent = 'Turn On';
        statusText.textContent = 'Idle';
    }
}

function appendLog(message) {
    const p = document.createElement('p');
    p.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    logDisplay.appendChild(p);
    logDisplay.scrollTop = logDisplay.scrollHeight; // Auto-scroll to bottom
}

function appendTranscript(text) {
    const p = document.createElement('div');
    p.classList.add('transcript-line');
    p.textContent = text;
    transcriptDisplay.appendChild(p);
    transcriptDisplay.scrollTop = transcriptDisplay.scrollHeight; // Auto-scroll
}

function updateCheatSheetItem(entity) {
    let itemElement = document.getElementById(`entity-${entity.name.replace(/\s+/g, '-')}`);
    if (!itemElement) {
        itemElement = document.createElement('div');
        itemElement.id = `entity-${entity.name.replace(/\s+/g, '-')}`;
        itemElement.classList.add('cheat-sheet-item');
        cheatSheetDisplay.appendChild(itemElement); // Add to display initially
    }

    itemElement.innerHTML = `
        <span class="type">${entity.type}</span>
        <strong>${entity.name}</strong>
        <p>${entity.description}</p>
    `;

    cheatSheetEntities.set(entity.name, entity); // Store in Map

    // Always re-apply sort and filter when an item is added/updated
    reSortAndFilterCheatSheet(); // Call a new function to handle this

    // No need to set display:none/block directly here, reSortAndFilterCheatSheet will handle it.
}

// --- NEW FUNCTION: Sorts and filters all displayed items ---
function reSortAndFilterCheatSheet() {
    const sortedEntities = Array.from(cheatSheetEntities.values()).sort((a, b) => a.name.localeCompare(b.name));
    cheatSheetDisplay.innerHTML = ''; // Clear current display

    if (sortedEntities.length === 0) {
        const emptyMessage = document.createElement('p');
        emptyMessage.id = 'emptyCheatSheetMessage';
        emptyMessage.style.cssText = 'text-align: center; color: #7b8394; margin-top: 20px;';
        emptyMessage.textContent = 'No entities identified yet. Play a video and click "Turn On".';
        cheatSheetDisplay.appendChild(emptyMessage);
        return; // Exit if empty
    }

    // Remove empty message if entities are present
    const existingMessage = document.getElementById('emptyCheatSheetMessage');
    if (existingMessage) {
        existingMessage.remove();
    }

    sortedEntities.forEach(entity => {
        const itemElement = document.createElement('div'); // Recreate elements
        itemElement.id = `entity-${entity.name.replace(/\s+/g, '-')}`;
        itemElement.classList.add('cheat-sheet-item');
        itemElement.innerHTML = `
            <span class="type">${entity.type}</span>
            <strong>${entity.name}</strong>
            <p>${entity.description}</p>
        `;
        
        // Apply filter when adding to display
        if (currentFilter === 'all' || entity.type === currentFilter) {
            itemElement.style.display = 'block';
        } else {
            itemElement.style.display = 'none';
        }
        cheatSheetDisplay.appendChild(itemElement);
    });
}

// --- LLM Communication Display Functions ---
function appendLLMCommunication(data) {
    if (data.prompt) {
        const promptElement = document.createElement('div');
        promptElement.classList.add('llm-prompt');
        promptElement.innerHTML = `
            <h4>Prompt</h4>
            <pre>${escapeHtml(data.prompt)}</pre>
        `;
        llmMonitorDisplay.appendChild(promptElement);
    }
    
    if (data.response) {
        const responseElement = document.createElement('div');
        responseElement.classList.add('llm-response');
        responseElement.innerHTML = `
            <h4>Response</h4>
            <pre>${escapeHtml(data.response)}</pre>
        `;
        llmMonitorDisplay.appendChild(responseElement);
    }
    
    llmMonitorDisplay.scrollTop = llmMonitorDisplay.scrollHeight; // Auto-scroll
}

// Helper function to escape HTML and preserve formatting
function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
        .replace(/\n/g, '<br>')
        .replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;');
}

// --- Socket.IO Event Handlers ---
socket.on('connect', () => {
    appendLog('Socket.IO connected to backend.');
});

socket.on('disconnect', () => {
    appendLog('Socket.IO disconnected from backend.');
    // If backend disconnected, set UI to off
    updateToggleButton(false); 
});

socket.on('status', (data) => {
    appendLog(`Backend Status: ${data.message}`);
    // If the backend sends a "stopped" status, ensure UI reflects it
    if (data.message.includes('stopped') || data.message.includes('Error')) {
        updateToggleButton(false);
    }
});

socket.on('initial_cheat_sheet', (data) => {
    cheatSheetEntities.clear(); // Clear before loading initial
    data.forEach(entity => cheatSheetEntities.set(entity.name, entity)); // Just add to map
    reSortAndFilterCheatSheet(); // Then re-sort and filter
    appendLog('Loaded initial cheat sheet from backend.');
});

socket.on('initial_transcript', (data) => {
    transcriptDisplay.innerHTML = ''; // Clear before loading initial
    data.history.forEach(line => appendTranscript(line));
    appendLog('Loaded initial transcript history from backend.');
});

socket.on('new_transcript', (data) => {
    appendTranscript(data.text);
    // Basic highlighting logic (can be refined)
    highlightEntitiesInTranscript(data.text);
});

socket.on('update_cheat_sheet', (entity) => {
    updateCheatSheetItem(entity);
    appendLog(`Cheat Sheet Updated: ${entity.name} (${entity.type})`);
});

// Add event listeners for clear_cheat_sheet and clear_transcript
// These are now only used when explicitly requested, not on every start
socket.on('clear_cheat_sheet', () => {
    cheatSheetEntities.clear();
    cheatSheetDisplay.innerHTML = '';
    appendLog('Cheat sheet cleared by backend.');
});

socket.on('clear_transcript', () => {
    transcriptDisplay.innerHTML = '';
    appendLog('Transcript display cleared by backend.');
});

// Add LLM communication handler
socket.on('llm_communication', (data) => {
    appendLLMCommunication(data);
});

// --- Event Listeners ---
toggleButton.addEventListener('click', async () => {
    if (isBackendRunning) {
        const response = await window.electronAPI.stopBackend();
        if (response.success) {
            updateToggleButton(false);
            appendLog('Backend stop command sent.');
        }
    } else {
        const customTitle = videoTitleInput.value.trim();
        if (customTitle) {
            appendLog(`Attempting to start with user-provided title: "${customTitle}"`);
            await window.electronAPI.setVideoTitle(customTitle); // Send title BEFORE starting
        } else {
            appendLog('Attempting to start backend via Electron API (auto-detecting title)...');
        }
        
        const response = await window.electronAPI.startBackend();
        if (response.success) {
            updateToggleButton(true);
            appendLog('Backend start command sent to Electron Main process. Waiting for backend to connect and report status...');
        } else {
            appendLog('ERROR: Failed to send start command to Electron Main process. Check main.js logs.');
        }
    }
});

// --- Initialize UI on load ---
async function initializeUI() {
    updateToggleButton(false);
    appendLog('App initialized. Backend is idle. Click "Turn On" to start.');
    reSortAndFilterCheatSheet(); // Ensure filter applied on empty list initially
}

// Call initializeUI when the document is loaded
document.addEventListener('DOMContentLoaded', () => {
    initializeUI();
    applyFilter(currentFilter); // Apply 'all' filter initially
});

// Basic Highlighting (MVP): This is a simplified version.
// A more robust solution would check transcript history.
let lastHighlightedEntity = null;
function highlightEntitiesInTranscript(transcriptText) {
    // Remove previous highlight
    if (lastHighlightedEntity) {
        const prevItem = document.getElementById(`entity-${lastHighlightedEntity.replace(/\s+/g, '-')}`);
        if (prevItem) {
            prevItem.classList.remove('highlight');
        }
        lastHighlightedEntity = null;
    }

    // Find if any existing entity name is in the transcript
    let foundEntityName = null;
    for (const [name, entity] of cheatSheetEntities.entries()) {
        // Simple case-insensitive match for MVP
        if (transcriptText.toLowerCase().includes(name.toLowerCase())) {
            foundEntityName = name;
            break; 
        }
    }

    if (foundEntityName) {
        const itemToHighlight = document.getElementById(`entity-${foundEntityName.replace(/\s+/g, '-')}`);
        if (itemToHighlight) {
            itemToHighlight.classList.add('highlight');
            lastHighlightedEntity = foundEntityName;
            // Scroll to highlight
            itemToHighlight.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }
}

// Add event listeners to filter buttons
filterButtons.forEach(button => {
    button.addEventListener('click', () => {
        // Remove active class from all buttons
        filterButtons.forEach(btn => btn.classList.remove('active'));
        // Add active class to clicked button
        button.classList.add('active');
        
        currentFilter = button.dataset.filter; // Get filter type from data-filter attribute
        reSortAndFilterCheatSheet(); // Re-sort and re-filter everything
    });
});

// New function to apply filter to all existing items
function applyFilter(filterType) {
    cheatSheetEntities.forEach(entity => {
        const itemElement = document.getElementById(`entity-${entity.name.replace(/\s+/g, '-')}`);
        if (itemElement) {
            if (filterType === 'all' || entity.type === filterType) {
                itemElement.style.display = 'block';
            } else {
                itemElement.style.display = 'none';
            }
        }
    });
}

// Add video title button handler
setVideoTitleBtn.addEventListener('click', async () => {
    const customTitle = videoTitleInput.value.trim();
    if (customTitle) {
        appendLog(`User set video title: "${customTitle}"`);
        await window.electronAPI.setVideoTitle(customTitle);
    }
});