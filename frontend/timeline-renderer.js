const timelineDisplay = document.getElementById('timelineDisplay');
const socket = io('http://127.0.0.1:5000');
const timelineEvents = new Map(); // Store events by name for updates

function appendTimelineEvent(eventData) {
    let eventElement = document.getElementById(`event-${eventData.name.replace(/\s+/g, '-')}`);
    if (!eventElement) {
        eventElement = document.createElement('div');
        eventElement.id = `event-${eventData.name.replace(/\s+/g, '-')}`;
        eventElement.classList.add('timeline-event');
        timelineDisplay.appendChild(eventElement);
    }

    eventElement.innerHTML = `
        <div class="date">${eventData.date || 'No date specified'}</div>
        <div class="name">${eventData.name}</div>
        <div class="description">${eventData.description}</div>
    `;

    timelineEvents.set(eventData.name, eventData);
    sortAndRenderTimeline();
}

function sortAndRenderTimeline() {
    // Convert Map to array and sort by date
    const sortedEvents = Array.from(timelineEvents.values()).sort((a, b) => {
        // If either event has no date, put it at the end
        if (!a.date) return 1;
        if (!b.date) return -1;
        return a.date.localeCompare(b.date);
    });

    // Clear and re-render
    timelineDisplay.innerHTML = '';
    sortedEvents.forEach(event => {
        const eventElement = document.getElementById(`event-${event.name.replace(/\s+/g, '-')}`);
        if (eventElement) {
            timelineDisplay.appendChild(eventElement);
        }
    });
}

// Socket.IO event handlers
socket.on('connect', () => {
    console.log('Timeline: Connected to backend');
});

socket.on('disconnect', () => {
    console.log('Timeline: Disconnected from backend');
});

socket.on('update_timeline_event', (eventData) => {
    console.log('Timeline: Received event update:', eventData);
    appendTimelineEvent(eventData);
});

// Request initial timeline data when connected
socket.on('connect', () => {
    socket.emit('request_timeline_data');
});

socket.on('initial_timeline_data', (data) => {
    console.log('Timeline: Received initial data:', data);
    timelineEvents.clear();
    data.forEach(event => appendTimelineEvent(event));
}); 