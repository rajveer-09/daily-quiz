# DailyQuiz

Timed class quizzes with a student site and an admin dashboard. Built with Node.js, Express and MongoDB, with a plain HTML/CSS/JS front end.

- **Students** sign in with their roll number and take scheduled, timed tests. Afterwards they see their score, every solution and the class leaderboard.
- **Admins** write quizzes, schedule tests, decide which question set each student gets, and see results day by day.

## Features

**Students**
- Sign in with just a roll number. A new roll number asks for a name once, which registers the student.
- The home page shows upcoming tests with a live countdown, their topics, the duration and the number of questions. Questions stay hidden until the student presses Start.
- Tests are timed:
  - The timer starts on Start and the server enforces it.
  - Answers save as the student picks them.
  - The test submits automatically when time runs out, even if the tab was closed.
- Results show the score, a breakdown by topic, and a solution for every question.
- Missed tests can still be taken later. These attempts are marked late.
- Leaderboards: overall and for each quiz. They show names only, never roll numbers.
- Profile page with progress, rank and stats, plus Appearance settings for the theme.

**Admin**
- **Tests:**
  - Schedule a test with a date, start time and duration.
  - Add one or more question sets (Set A, Set B…) and choose who gets each one: groups, individual students, or "everyone else".
  - A set can **jumble the question order**: same questions, a different fixed order for each set.
- **Question bank:** a quiz editor with code blocks, 2–6 options, explanations and topics. Editing a quiz re-marks existing attempts.
- **Daily results:** what every student scored on a given day, whatever their set, plus a 14-day grid. Both export to CSV.
- **Analytics for each quiz:** right answers per question, how scores are spread, results by topic, and the hardest questions with the most common wrong answer.
- **Groups:** a board to drag students between groups.
- **Students:** paste a roster to import it, and change a student's group inline.

**Design:** a dark frosted-glass look that works on desktop and phone. There are four themes (Mono, Emerald, Gold and Rose), and each person picks theirs under Appearance.

## Run locally

Requirements: Node.js 20 or newer, and a MongoDB database (Atlas or local).

```bash
npm install
# create a .env file (see below)
npm start
```

- Student site: http://localhost:3000
- Admin: http://localhost:3000/admin

### Environment variables (`.env`)

| Variable | Purpose |
|---|---|
| `MONGODB_URI` | MongoDB connection string |
| `DB_NAME` | Database name (default `daily_quiz`) |
| `PORT` | HTTP port (default `3000`) |
| `QUIZ_TZ` | Time zone for test times (default `Asia/Kolkata`) |
| `ADMIN_EMAIL` | Admin sign-in email |
| `ADMIN_PASSWORD` | Admin sign-in password |
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
