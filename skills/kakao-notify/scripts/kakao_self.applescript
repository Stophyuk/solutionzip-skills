-- Paste a message into KakaoTalk's front chat window and press Return.
--
--   osascript kakao_self.applescript "message" "window title"
--
-- Sends only when KakaoTalk's front window is titled exactly <window title> (your "나와의 채팅" window),
-- so a message never lands in someone else's chat. The clipboard is restored afterwards.
-- Needs Accessibility permission for the app that runs osascript (Terminal, iTerm, Claude Code's host).
on run argv
	if (count of argv) < 2 then
		return "ERROR: usage — osascript kakao_self.applescript <message> <window title>"
	end if
	set msgText to item 1 of argv
	set wantTitle to item 2 of argv

	-- Check the title before activating, so a skipped send does not pull KakaoTalk to the front
	tell application "System Events"
		if not (exists process "KakaoTalk") then return "SKIP: KakaoTalk is not running"
		tell process "KakaoTalk"
			if (count of windows) = 0 then return "SKIP: no KakaoTalk window"
			if (name of window 1) is not wantTitle then return "SKIP: front window is not the self chat"
		end tell
	end tell

	tell application "KakaoTalk" to activate
	delay 0.8

	tell application "System Events"
		tell process "KakaoTalk"
			set frontmost to true
			delay 0.3
			-- The window order can change while activating; check once more right before pasting
			if (name of window 1) is not wantTitle then return "SKIP: front window changed"
			try
				perform action "AXRaise" of window 1
			end try
		end tell
	end tell

	-- Keep whatever the user had copied
	set hadClip to true
	try
		set oldClip to the clipboard
	on error
		set hadClip to false
	end try

	set the clipboard to msgText
	delay 0.2
	tell application "System Events"
		keystroke "v" using {command down}
		delay 0.5
		key code 36
		delay 0.3
	end tell

	if hadClip then
		delay 0.3
		set the clipboard to oldClip
	end if
	return "OK"
end run
