# Py Debug Plus

Extra tools on top of the normal Python debugger (debugpy). Start debugging as usual (F5) — this extension attaches to the session.

| Feature | How |
|---|---|
| Step back | Status bar **Back**, editor title button, `Ctrl+Alt+Left`. `Ctrl+Alt+Right` is **Forward**: the next recorded step while replaying, or run to the next line when the program is paused live. |
| List range | Right-click a variable → **Set List Range…**, or use the range boxes in Live Variables. |
| Live variables | Panel opens on session start (or **Py Debug Plus: Open Live Variables**). Changed values are highlighted. |
| Edit values | Double-click any value in Live Variables (lists, dict entries, object attributes). Type a Python expression, e.g. `42`, `"hi"`, `[1, 2]`, `Player("Sam", 100)`. Enter to apply. |
| Library code | `stepIntoLibraries` turns off debugpy's `justMyCode` so the debugger can stop inside built-in and pip code. This extension never opens files itself. |
| Continue | Status bar **Continue**, editor title button, `Ctrl+Alt+C` (F5 still works). |

The Live Variables panel and step-back history skip it (setting `showLibraryVariables` turns it back on).

Imported modules from pip or Python itself are hidden from Live Variables; your own modules show as one line and are not expanded.

**Chosen variables only:** the panel shows nothing until you pick. Type a name in the box at the top and press Add. Add Python-style slices to limit lists, e.g. `entities[0:10]`, or `entities[0:10][0:10]` for a list of lists (first brackets apply to the list, second to each item inside it; end is excluded, `[5:]` means to the end). The name can be a variable that does not exist yet: it appears as "not available at this stop yet" and fills in once created, using the range you set. Click **Choose variables…** (or run the command of the same name), tick what you want to watch, and only those are shown. Untick a box in the panel to remove one. **Show all** switches to everything. Choices are remembered per workspace.

**Troubleshooting:** Output > *Py Debug Plus* logs every stop and every file it opens or skips (command: *Py Debug Plus: Show Log*).

## Limits
- **Step back is a replay.** It shows the recorded line and variables from earlier stops. The program itself does not rewind, and prints/file writes/network calls are not undone. Stepping or continuing resumes from the real position.
- A stop is recorded each time the debugger pauses, so stepping line by line gives line-by-line history.
- List ranges and live values are shown in the Live Variables panel; extensions cannot change the built-in Variables panel.
- Values can only be read or edited while the program is paused, and not in replay.
- What you type when editing is run as real Python in your program, so constructors and other side effects run.
- Python may refuse some edits (items in a tuple, read-only properties); the error is shown.
- `stepIntoLibraries` applies to sessions started after you change it.

- When VS Code closes, running debug sessions are stopped (setting `stopDebuggingOnClose`). A program started in an external terminal window, or VS Code being force-killed, can't be stopped this way.
- Slices like `entities[0:10][0:10]` apply to lists and tuples at each nesting level. A bracket for a level that holds objects (not lists) has no effect.
- Single items work too: `blocks[0]` shows element 0 of `blocks`; `blocks[0][2:5]` shows items 2 to 4 of that element.
- While paused, your chosen variables also appear at the end of the code lines that use them. VS Code's own inline values (every variable) are turned off for this (`hideDefaultInlineValues`).
- A variable with a range shows only the chosen items (`blocks[18:22]` shows `blocks[18]` to `blocks[21]`), not the list row itself. Untick any of those rows to stop watching the variable. To change the range, add it again with new brackets.
- **Limit a variable to one function or class:** put the name before a colon, e.g. `drawall:blocks[0:5]`, `Entity:pos` (any method of class Entity) or `Entity.update:self.pos` (only that method). It then shows only while paused in that function or class, so same-named locals in other functions don't mix. `module:` means top-level code. Without a prefix, a variable shows wherever it exists.
- **Run a Python line:** type it in the box at the top of Live Variables (or run *Py Debug Plus: Run a Python Line*) and press Enter; Up/Down recall earlier lines. If the program is paused, the line runs in your own code's nearest frame. If it is running, the extension pauses it, runs the line, and continues. Put `function: ` or `Class: ` first (e.g. `drawall: score += 10`) to run it inside that function or class; it retries pausing (`runLineMaxTries`) until the program is there. Statements joined with `;` work; multi-line blocks do not. The line really changes your program, and anything it prints goes to the Debug Console. VS Code's own debug UI may flash briefly at each automatic pause.
- A line like `x: int = 5` looks like `function: code`; put a scope in front to be explicit, e.g. `module: x: int = 5`.
- **Live refresh:** the *Live refresh* button in the panel (or *Toggle Live Refresh*) re-reads your chosen variables while the program runs by pausing it briefly every `liveRefreshMs` (1000 ms by default). Games may stutter at each pause, and VS Code's own debug UI may flash. It reads from the nearest frame of your own code (or one that matches a `function:` name you used). These pauses are not added to the Back history.
- **Rerun on save:** the status bar item *Rerun on save* (or *Toggle Rerun on Save*) restarts the debug session with the same launch settings whenever you save a Python file in the project (`rerunDelayMs` waits so quick saves restart once). Restarting resets the program's state. Unsaved typing does not trigger it.
- **Run a line in a file:** `engineV2.py: score += 10` runs in a frame from that file if the program is in it when paused, otherwise in that file's top-level variables. `engineV2.py:drawall: score += 10` runs inside that function (retrying the pause). In top-level mode, results of expressions are shown, assignments and calls are run.
- **Creation order:** an object's attributes (and dictionary entries, when debugpy lists them as plain rows) are shown in the order they were created (`orderByCreation`). Class-level values and properties come after.
- **Pause / Force refresh:** the panel's *Pause* button pauses the program and keeps it paused (Continue resumes). *Force refresh* reads the values right now: if the program is running it pauses it for a moment, reads, and continues. The line under the buttons says what live refresh last did or why it could not (for example "the program did not pause within 3 s"); the same text is in Output > Py Debug Plus.
- Live refresh is always off when VS Code starts, and it never sends anything to the debugger in the first 3 seconds of a session, so it cannot interfere with the program launching. Turn it on from the panel once the program is running.
- **Fast reads:** with Show all OFF, only your chosen variables are read, each one looked up in whichever frame on the call stack has it (so a top-level variable like `obj` is found even while the program is deep inside a function). Lists are read only for the range you set. Turn Show all ON to read every variable in the frame (slow for big lists).
- **Pause always wins:** if you press Pause while live refresh is mid-read, the program stays paused. If VS Code's own pause has no effect, the extension sends a pause request itself, and logs what happened (Output > Py Debug Plus).
