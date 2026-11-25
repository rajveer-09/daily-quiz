# BigONotebook

Timed class quizzes with a student site and an admin dashboard. Built with Node.js, Express and MongoDB, with a plain HTML/CSS/JS front end.

- **Students** sign in with their roll number, take scheduled, timed tests, see their score and their hall's leaderboard, and read the class notes.
- **Admins** write question papers, schedule tests, decide which paper each student gets, and analyse the results.

## Features

**Students**
- Sign in with a roll number and the class password (`STUDENT_PASSWORD`). A new roll number asks for a name once, which registers the student.
- The home page shows upcoming tests with a live countdown, their topics, the duration and the number of questions. Questions stay hidden until the student presses Start.
- Tests are timed:
  - The timer starts on Start and the server enforces it.
  - Answers save as the student picks them.
  - The test submits automatically when time runs out, even if the tab was closed.
  - A test can require full screen. Leaving full screen submits it.
- The score and leaderboard update in real time. The answers and explanations unlock when the test window closes, so nobody can share them while others are still writing.
- Missed tests can still be taken later. These attempts are marked late.
- Leaderboards are separate for each hall: overall and for each test. They show names only, never roll numbers.
- **Notes:** class notes by level and topic, with highlighted code, copy buttons, a section list and a full-screen reading mode.
- Profile page with progress, hall rank and stats.

**Admin**
- **Tests:**
  - Schedule a test with its own name, a date, start time and duration. The same question paper can be reused in many tests.
  - Add one or more question papers and choose who gets each one: groups, individual students, or "everyone else".
  - A paper can **jumble the question order**: same questions, a different fixed order.
- **Analysis for each test:** the most-missed questions with how many picked each option, accuracy by topic, by position in the paper and by time into the test, time per question, and how each student's attempt ended. Exports to CSV.
- **Question bank:** an editor with code blocks, 2–6 options, explanations and topics. Editing a paper re-marks existing attempts.
- **Daily results:** what every student scored on a given day, plus a 14-day grid. Both export to CSV.
- **Leaderboards** by hall and test, showing the students who took part.
- **Students:** grouped by hall. Import a roster, change a student's group or hall, and **view the site as any student** (read-only).
- **Groups:** a board to drag students between groups.
- **Notes:** the same notes students see.

**Design:** a clean, flat look with light and dark modes (it follows the device setting until changed). Works on desktop and phone, and the left menu can be collapsed.

## Performance and reliability

- **Caching:** tests, quizzes, groups and student records are kept in server memory and cleared on every admin change. A student page needs a single database read.
- **Leaderboards:** computed at most every 10 seconds, and recomputed straight away after each submission.
- **Static files:** CSS and JS are compressed once at startup (brotli or gzip) and carry a content hash in their URL. Browsers cache them for a year and download them again only after a deploy changes them.
- **Atomic attempts:**
  - Each saved answer is one conditional write that also checks the deadline.
  - Submitting first locks the attempt in a single operation (`started -> grading`). This blocks any further answer saves and returns the final answers, so every answer is either counted or rejected, never lost.
  - Many simultaneous starts or submits produce exactly one attempt, graded once.
- **Safe admin edits:** saving a quiz or test is rejected with a 409 if someone else saved it after it was loaded. Nothing is silently overwritten.
- **Startup:** the server retries the MongoDB connection until it succeeds, instead of crashing.

## Run locally

Requirements: Node.js 20 or newer, and a MongoDB database (Atlas or local).

```bash
npm install
# create a .env file (see below)
npm start
```

- Student site: http://localhost:3000
- Admin: http://localhost:3000/admin
- Health check: http://localhost:3000/api/health returns 200 with `{"ok":true,"db":"up"}`, or 503 if the database is unreachable. Point an uptime monitor or cron ping at it.

### Environment variables (`.env`)

| Variable | Purpose |
|---|---|
| `MONGODB_URI` | MongoDB connection string |
| `DB_NAME` | Database name (default `daily_quiz`) |
| `PORT` | HTTP port (default `3000`) |
| `QUIZ_TZ` | Time zone for test times (default `Asia/Kolkata`) |
| `STUDENT_PASSWORD` | Shared password students enter with their roll number (default `notebook`) |
| `ADMIN_EMAIL` | Admin sign-in email |
| `ADMIN_PASSWORD` | Admin sign-in password |
| `ADMINS` | Optional extra admins, as `email:password,email:password` |
| `ADMIN_SECRET` | Long random string that signs admin sessions |

## Project layout

```
server.js        Express API, scheduling, timing and marking
public/          Front end: index.html (students), admin.html, styles.css, common.js, app.js, admin.js
quizzes/         Starter quizzes, added to the database once on first run
```

## Data model (MongoDB)

| Collection | Contents |
|---|---|
| `students` | `roll` (unique), `name`, `set` (the group) |
| `sets` | Groups: `_id`, `name`, `order` |
| `quizzes` | `title`, `description`, `topics`, `duration`, `questions[]` |
| `tests` | `date`, `start`, `duration`, `papers[{ quizId, everyone, sets[], rolls[], shuffle }]` |
| `attempts` | `roll`, `quizId`, `status`, `startedAt`, `deadline`, `order`, `byQ`, `score`, `total`, `secs`, `auto` |
