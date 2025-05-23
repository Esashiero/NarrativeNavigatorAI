const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let mainWindow;
let pythonProcess;

const PYTHON_EXECUTABLE = process.platform === 'win32' ? 'python' : 'python3'; // 'python.exe' on Windows might be safer, but 'python' should work if in PATH
const PYTHON_SCRIPT = path.join(__dirname, '..', 'backend', 'app.py');
const PYTHON_VENV_EXECUTABLE = path.join(__dirname, '..', 'navigator-ai-venv', 'Scripts', 'python.exe');

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'), // For secure IPC
            nodeIntegration: false, // Keep false for security
            contextIsolation: true // Keep true for security
        }
    });

    mainWindow.loadFile('index.html');
    // Open the DevTools.
    // mainWindow.webContents.openDevTools();
}

// Function to check if Python venv exists and use it
function getPythonExecutable() {
    if (fs.existsSync(PYTHON_VENV_EXECUTABLE)) {
        console.log(`Using Python from virtual environment: ${PYTHON_VENV_EXECUTABLE}`);
        return PYTHON_VENV_EXECUTABLE;
    }
    console.log(`Using global Python executable: ${PYTHON_EXECUTABLE}`);
    return PYTHON_EXECUTABLE;
}

function startPythonBackend() {
    const pythonExe = getPythonExecutable();
    pythonProcess = spawn(pythonExe, [PYTHON_SCRIPT]);

    pythonProcess.stdout.on('data', (data) => {
        console.log(`Python stdout: ${data}`);
        // Optionally send Python stdout to renderer for debugging UI
        // mainWindow.webContents.send('python-log', data.toString());
    });

    pythonProcess.stderr.on('data', (data) => {
        console.error(`Python stderr: ${data}`);
        // Send errors to renderer to display to user
        mainWindow.webContents.send('python-log', `ERROR: ${data.toString()}`);
    });

    pythonProcess.on('close', (code) => {
        console.log(`Python process exited with code ${code}`);
        pythonProcess = null;
        mainWindow.webContents.send('backend-status', 'stopped');
    });

    pythonProcess.on('error', (err) => {
        console.error('Failed to start Python process:', err);
        mainWindow.webContents.send('python-log', `ERROR: Failed to start Python backend. Make sure Python is installed and backend dependencies are met. ${err.message}`);
        mainWindow.webContents.send('backend-status', 'stopped');
    });
}

function stopPythonBackend() {
    if (pythonProcess) {
        // Send a signal to the backend to shut down gracefully
        // Or directly kill the process if graceful shutdown is not implemented/desired
        fetch('http://127.0.0.1:5000/stop', { method: 'POST' })
            .then(response => response.json())
            .then(data => console.log('Backend stop response:', data))
            .catch(error => console.error('Error stopping backend via API:', error));
            
        // Give it a moment to shut down, then kill if it hasn't
        setTimeout(() => {
            if (pythonProcess) {
                console.log("Forcibly killing Python process.");
                pythonProcess.kill(); // Kills the process (SIGTERM)
            }
        }, 3000); // 3 seconds
    }
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });

    // Handle app close: ensure Python process is killed
    app.on('before-quit', (event) => {
        if (pythonProcess) {
            console.log("App quitting, killing Python process.");
            pythonProcess.kill();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// IPC handlers for renderer process to communicate with main process
ipcMain.handle('start-backend', async () => {
    startPythonBackend();
    return { success: true };
});

ipcMain.handle('stop-backend', async () => {
    stopPythonBackend();
    return { success: true };
});

ipcMain.handle('fetch-status', async () => {
    try {
        const response = await fetch('http://127.0.0.1:5000/status');
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error fetching status:', error);
        return { is_listening: false, error: error.message };
    }
});

ipcMain.handle('fetch-cheat-sheet', async () => {
    try {
        const response = await fetch('http://127.0.0.1:5000/cheat_sheet');
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error fetching cheat sheet:', error);
        return [];
    }
});