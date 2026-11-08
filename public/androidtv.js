// Android TV Portal JavaScript
// Optimized for remote control navigation

class AndroidTVPortal {
    constructor() {
        this.rooms = [];
        this.focusableElements = [];
        this.currentFocusIndex = 0;
        this.currentView = 'rooms'; // 'rooms' or 'actions'
        this.selectedRoom = null;
        
        this.init();
    }

    init() {
        this.loadRooms();
        this.setupKeyboardNavigation();
        this.setupEventListeners();
    }

    async loadRooms() {
        try {
            const response = await fetch('/api/rooms');
            const data = await response.json();
            
            if (data.success) {
                this.rooms = data.data;
                this.renderRooms();
                this.updateFocusableElements();
                this.hideLoading();
                
                // Focus the first room card
                if (this.focusableElements.length > 0) {
                    this.setFocus(0);
                }
            } else {
                this.showError('Failed to load rooms');
            }
        } catch (error) {
            console.error('Error loading rooms:', error);
            this.showError('Network error loading rooms');
        }
    }

    renderRooms() {
        const roomsGrid = document.getElementById('roomsGrid');
        roomsGrid.innerHTML = '';

        if (this.rooms.length === 0) {
            roomsGrid.innerHTML = '<div class="loading-message">No rooms available</div>';
            return;
        }

        this.rooms.forEach((room, index) => {
            const roomCard = document.createElement('div');
            roomCard.className = 'room-card';
            roomCard.tabIndex = 0;
            roomCard.setAttribute('data-room-id', room.id);
            roomCard.setAttribute('data-room-index', index);
            
            roomCard.innerHTML = `
                <div class="room-name">${this.escapeHtml(room.name)}</div>
                <div class="room-shortcode">Code: ${room.shortcode}</div>
                <div class="room-actions" id="actions-${room.id}">
                    <button class="action-button rules" data-action="rules" data-room-id="${room.id}" tabindex="-1">
                        📖 Rules
                    </button>
                    <button class="action-button play" data-action="play" data-room-id="${room.id}" tabindex="-1">
                        🎮 Play
                    </button>
                </div>
            `;

            roomsGrid.appendChild(roomCard);
        });
    }

    setupKeyboardNavigation() {
        document.addEventListener('keydown', (e) => {
            e.preventDefault(); // Prevent default browser navigation

            switch (e.key) {
                case 'ArrowUp':
                    this.navigateUp();
                    break;
                case 'ArrowDown':
                    this.navigateDown();
                    break;
                case 'ArrowLeft':
                    this.navigateLeft();
                    break;
                case 'ArrowRight':
                    this.navigateRight();
                    break;
                case 'Enter':
                case ' ': // Space key
                    this.activateCurrentElement();
                    break;
                case 'Escape':
                case 'Backspace':
                    this.goBack();
                    break;
            }
        });
    }

    setupEventListeners() {
        // Back button
        const backButton = document.getElementById('backButton');
        backButton.addEventListener('click', () => this.goBack());
        
        // Room card clicks (for mouse/touch)
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('room-card')) {
                const roomId = e.target.getAttribute('data-room-id');
                this.selectRoom(roomId);
            } else if (e.target.classList.contains('action-button')) {
                const action = e.target.getAttribute('data-action');
                const roomId = e.target.getAttribute('data-room-id');
                this.executeAction(action, roomId);
            }
        });
    }

    updateFocusableElements() {
        if (this.currentView === 'rooms') {
            this.focusableElements = Array.from(document.querySelectorAll('.room-card'));
        } else if (this.currentView === 'actions') {
            const backButton = document.getElementById('backButton');
            const actionButtons = Array.from(document.querySelectorAll('.action-button:not([tabindex="-1"])'));
            this.focusableElements = [backButton, ...actionButtons];
        } else if (this.currentView === 'no-rules') {
            const playBtn = document.getElementById('no-rules-play-btn');
            const backBtn = document.getElementById('no-rules-back-btn');
            this.focusableElements = [playBtn, backBtn];
        }
    }

    setFocus(index) {
        // Remove focus from all elements
        this.focusableElements.forEach(el => {
            el.classList.remove('focused');
            el.blur();
        });

        // Bound check
        if (index < 0) index = this.focusableElements.length - 1;
        if (index >= this.focusableElements.length) index = 0;

        this.currentFocusIndex = index;

        // Focus the current element
        if (this.focusableElements[index]) {
            this.focusableElements[index].focus();
            this.focusableElements[index].classList.add('focused');
        }
    }

    navigateUp() {
        if (this.currentView === 'rooms') {
            // Navigate up in grid (2 columns)
            const newIndex = this.currentFocusIndex - 2;
            this.setFocus(newIndex >= 0 ? newIndex : this.currentFocusIndex);
        } else if (this.currentView === 'actions') {
            // Navigate up in action buttons
            if (this.currentFocusIndex > 0) {
                this.setFocus(this.currentFocusIndex - 1);
            }
        }
    }

    navigateDown() {
        if (this.currentView === 'rooms') {
            // Navigate down in grid (2 columns)
            const newIndex = this.currentFocusIndex + 2;
            this.setFocus(newIndex < this.focusableElements.length ? newIndex : this.currentFocusIndex);
        } else if (this.currentView === 'actions') {
            // Navigate down in action buttons
            if (this.currentFocusIndex < this.focusableElements.length - 1) {
                this.setFocus(this.currentFocusIndex + 1);
            }
        }
    }

    navigateLeft() {
        if (this.currentView === 'rooms') {
            // Navigate left in grid
            if (this.currentFocusIndex > 0) {
                this.setFocus(this.currentFocusIndex - 1);
            }
        } else if (this.currentView === 'actions' && this.currentFocusIndex > 0) {
            // Navigate left in action buttons (only if not on back button)
            const newIndex = this.currentFocusIndex === 2 ? 1 : this.currentFocusIndex - 1;
            if (newIndex >= 0) {
                this.setFocus(newIndex);
            }
        }
    }

    navigateRight() {
        if (this.currentView === 'rooms') {
            // Navigate right in grid
            if (this.currentFocusIndex < this.focusableElements.length - 1) {
                this.setFocus(this.currentFocusIndex + 1);
            }
        } else if (this.currentView === 'actions' && this.currentFocusIndex < this.focusableElements.length - 1) {
            // Navigate right in action buttons
            const newIndex = this.currentFocusIndex === 1 ? 2 : this.currentFocusIndex + 1;
            if (newIndex < this.focusableElements.length) {
                this.setFocus(newIndex);
            }
        }
    }

    activateCurrentElement() {
        const currentElement = this.focusableElements[this.currentFocusIndex];
        if (!currentElement) return;

        if (currentElement.classList.contains('room-card')) {
            const roomId = currentElement.getAttribute('data-room-id');
            this.selectRoom(roomId);
        } else if (currentElement.classList.contains('action-button')) {
            const action = currentElement.getAttribute('data-action');
            const roomId = currentElement.getAttribute('data-room-id');
            this.executeAction(action, roomId);
        } else if (currentElement.id === 'backButton') {
            this.goBack();
        }
    }

    selectRoom(roomId) {
        const room = this.rooms.find(r => r.id === roomId);
        if (!room) return;

        this.selectedRoom = room;

        // Add selection animation
        const roomCard = document.querySelector(`[data-room-id="${roomId}"]`);
        roomCard.classList.add('selecting');

        setTimeout(() => {
            roomCard.classList.remove('selecting');
            this.showRoomActions(roomId);
        }, 300);
    }

    showRoomActions(roomId) {
        // Hide all rooms except selected
        const allRoomCards = document.querySelectorAll('.room-card');
        allRoomCards.forEach(card => {
            if (card.getAttribute('data-room-id') !== roomId) {
                card.style.display = 'none';
            }
        });

        // Show actions for selected room
        const actionsDiv = document.getElementById(`actions-${roomId}`);
        actionsDiv.classList.add('visible');

        // Update action button tab indices to make them focusable
        const actionButtons = actionsDiv.querySelectorAll('.action-button');
        actionButtons.forEach(btn => btn.tabIndex = 0);

        // Show back button
        const backButton = document.getElementById('backButton');
        backButton.classList.add('visible');

        // Switch to actions view
        this.currentView = 'actions';
        this.updateFocusableElements();
        this.setFocus(1); // Focus first action button (index 1, after back button)
    }

    async executeAction(action, roomId) {
        const room = this.rooms.find(r => r.id === roomId);
        if (!room) return;

        if (action === 'rules') {
            // Check if rules exist for this room
            try {
                // New slideshows first, then media from the original rules editor
                const shows = await fetch(`/api/v2/rooms/${roomId}/slideshows`).then(r => r.json()).catch(() => null);
                const hasShows = shows && shows.success && shows.data.some(s => s.slideCount > 0);
                const response = hasShows ? null : await fetch(`/api/rooms/${roomId}/rules`);
                const data = hasShows ? { success: true, data: [1] } : await response.json();

                if (data.success && data.data && data.data.length > 0) {
                    // Rules exist, navigate to rules slideshow
                    window.location.href = `/room/${roomId}/rules-slideshow`;
                } else {
                    // No rules exist, show message
                    this.showNoRulesMessage(room);
                }
            } catch (error) {
                console.error('Error checking rules:', error);
                // Fallback to rules slideshow
                window.location.href = `/room/${roomId}/rules-slideshow`;
            }
        } else if (action === 'play') {
            // Navigate to player page using shortcode
            window.location.href = `/p/${room.shortcode}`;
        }
    }

    goBack() {
        if (this.currentView === 'actions') {
            // Hide action buttons and back button
            const allActionDivs = document.querySelectorAll('.room-actions');
            allActionDivs.forEach(div => {
                div.classList.remove('visible');
                // Reset action button tab indices
                div.querySelectorAll('.action-button').forEach(btn => btn.tabIndex = -1);
            });

            const backButton = document.getElementById('backButton');
            backButton.classList.remove('visible');

            // Show all room cards
            const allRoomCards = document.querySelectorAll('.room-card');
            allRoomCards.forEach(card => {
                card.style.display = 'flex';
            });

            // Switch back to rooms view
            this.currentView = 'rooms';
            this.updateFocusableElements();
            
            // Focus the previously selected room
            const selectedRoomIndex = this.rooms.findIndex(r => r.id === this.selectedRoom.id);
            this.setFocus(selectedRoomIndex >= 0 ? selectedRoomIndex : 0);
            
            this.selectedRoom = null;
        } else if (this.currentView === 'no-rules') {
            // Use the dedicated goBackToRooms method
            this.goBackToRooms();
        }
    }

    hideLoading() {
        const loadingMessage = document.getElementById('loadingMessage');
        loadingMessage.style.display = 'none';
    }

    showError(message) {
        const loadingMessage = document.getElementById('loadingMessage');
        loadingMessage.textContent = message;
        loadingMessage.style.color = '#ff6b6b';
    }

    showNoRulesMessage(room) {
        // Hide the room selection interface
        const roomsGrid = document.getElementById('roomsGrid');
        roomsGrid.style.display = 'none';

        // Show no rules message
        const mainContent = document.querySelector('.main-content');
        const noRulesDiv = document.createElement('div');
        noRulesDiv.className = 'no-rules-message';
        noRulesDiv.innerHTML = `
            <div class="no-rules-card">
                <div class="no-rules-icon">📚</div>
                <h2>No Rules Available</h2>
                <p>No rules have been created for <strong>${this.escapeHtml(room.name)}</strong></p>
                <div class="no-rules-actions">
                    <button class="action-button play" id="no-rules-play-btn" tabindex="0">
                        🎮 Go to Player
                    </button>
                    <button class="action-button rules" id="no-rules-back-btn" tabindex="0">
                        ← Back to Rooms
                    </button>
                </div>
            </div>
        `;

        // Add styles for the no rules message
        const style = document.createElement('style');
        style.textContent = `
            .no-rules-message {
                display: flex;
                justify-content: center;
                align-items: center;
                min-height: 400px;
                width: 100%;
            }
            
            .no-rules-card {
                background: var(--bg-light);
                border: 3px solid transparent;
                border-radius: 20px;
                padding: 3rem;
                text-align: center;
                max-width: 600px;
                width: 100%;
            }
            
            .no-rules-icon {
                font-size: 4rem;
                margin-bottom: 1rem;
            }
            
            .no-rules-card h2 {
                font-size: 2.5rem;
                margin-bottom: 1rem;
                color: var(--text-light);
            }
            
            .no-rules-card p {
                font-size: 1.5rem;
                color: var(--text-muted);
                margin-bottom: 2rem;
            }
            
            .no-rules-actions {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 1rem;
            }
        `;
        document.head.appendChild(style);

        mainContent.appendChild(noRulesDiv);

        // Setup event listeners
        const playBtn = document.getElementById('no-rules-play-btn');
        const backBtn = document.getElementById('no-rules-back-btn');

        playBtn.addEventListener('click', () => {
            window.location.href = `/p/${room.shortcode}`;
        });

        backBtn.addEventListener('click', () => {
            this.goBackToRooms();
        });

        // Update focusable elements and focus the play button
        this.currentView = 'no-rules';
        this.focusableElements = [playBtn, backBtn];
        this.setFocus(0);
    }

    goBackToRooms() {
        // Remove no rules message if it exists
        const noRulesMessage = document.querySelector('.no-rules-message');
        if (noRulesMessage) {
            noRulesMessage.remove();
        }

        // Show rooms grid
        const roomsGrid = document.getElementById('roomsGrid');
        roomsGrid.style.display = 'grid';

        // Reset to rooms view
        this.currentView = 'rooms';
        this.updateFocusableElements();
        this.setFocus(0);
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize the Android TV Portal when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new AndroidTVPortal();
});

// Handle gamepad input (for Android TV remotes that appear as gamepads)
window.addEventListener('gamepadconnected', (e) => {
    console.log('Gamepad connected:', e.gamepad);
});

// Gamepad polling for button presses
let gamepadPolling = null;

function pollGamepad() {
    const gamepads = navigator.getGamepads();
    for (let i = 0; i < gamepads.length; i++) {
        const gamepad = gamepads[i];
        if (gamepad) {
            // D-pad or left stick
            if (gamepad.buttons[12] && gamepad.buttons[12].pressed) { // D-pad up
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
            }
            if (gamepad.buttons[13] && gamepad.buttons[13].pressed) { // D-pad down
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
            }
            if (gamepad.buttons[14] && gamepad.buttons[14].pressed) { // D-pad left
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
            }
            if (gamepad.buttons[15] && gamepad.buttons[15].pressed) { // D-pad right
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
            }
            if (gamepad.buttons[0] && gamepad.buttons[0].pressed) { // A button / OK
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
            }
            if (gamepad.buttons[1] && gamepad.buttons[1].pressed) { // B button / Back
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
            }
        }
    }
    gamepadPolling = requestAnimationFrame(pollGamepad);
}

// Start gamepad polling when a gamepad is connected
window.addEventListener('gamepadconnected', () => {
    if (!gamepadPolling) {
        pollGamepad();
    }
});

// Stop gamepad polling when all gamepads are disconnected
window.addEventListener('gamepaddisconnected', () => {
    const gamepads = navigator.getGamepads();
    let hasGamepad = false;
    for (let i = 0; i < gamepads.length; i++) {
        if (gamepads[i]) {
            hasGamepad = true;
            break;
        }
    }
    if (!hasGamepad && gamepadPolling) {
        cancelAnimationFrame(gamepadPolling);
        gamepadPolling = null;
    }
});