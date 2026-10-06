"""Flask backend for the online attendance management system."""

from __future__ import annotations

import base64
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, render_template, request, send_from_directory

try:
    import cv2
    import numpy as np
except ImportError:  # Camera verification remains available through the browser.
    cv2 = None
    np = None

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATABASE_PATH = PROJECT_ROOT / "python" / "attendance.db"
HTML_DIR = PROJECT_ROOT / "html"
CSS_DIR = PROJECT_ROOT / "css"
JAVASCRIPT_DIR = PROJECT_ROOT / "java script"
PERIODS = (
    (1, 9 * 60, 10 * 60),
    (2, 10 * 60, 11 * 60),
    (3, 11 * 60, 12 * 60),
    (4, 13 * 60, 14 * 60),
    (5, 14 * 60, 15 * 60),
)

app = Flask(__name__, template_folder=str(HTML_DIR))


def get_connection() -> sqlite3.Connection:
    """Open a database connection with dictionary-like rows."""
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def init_database() -> None:
    """Create application tables and indexes when the server starts."""
    with get_connection() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS students (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_id TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                department TEXT NOT NULL DEFAULT 'New student',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS attendance (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_id TEXT NOT NULL,
                name TEXT NOT NULL,
                department TEXT NOT NULL,
                attendance_date TEXT NOT NULL,
                period_number INTEGER,
                day_name TEXT NOT NULL,
                month_name TEXT NOT NULL,
                year INTEGER NOT NULL,
                check_in_time TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('Present', 'Late', 'Absent')),
                face_detected INTEGER NOT NULL DEFAULT 0,
                reaction TEXT NOT NULL DEFAULT 'Unknown',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(student_id, attendance_date, period_number)
            );
            """
        )

        columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(attendance)").fetchall()
        }
        unique_keys = []
        for index in connection.execute("PRAGMA index_list(attendance)").fetchall():
            if index["unique"]:
                unique_keys.append([
                    row["name"]
                    for row in connection.execute(
                        f"PRAGMA index_info('{index['name']}')"
                    ).fetchall()
                ])

        if "period_number" not in columns or ["student_id", "attendance_date"] in unique_keys:
            legacy_period = "period_number" if "period_number" in columns else "NULL"
            connection.execute("ALTER TABLE attendance RENAME TO attendance_legacy")
            connection.execute(
                """
                CREATE TABLE attendance (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    student_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    department TEXT NOT NULL,
                    attendance_date TEXT NOT NULL,
                    period_number INTEGER,
                    day_name TEXT NOT NULL,
                    month_name TEXT NOT NULL,
                    year INTEGER NOT NULL,
                    check_in_time TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('Present', 'Late', 'Absent')),
                    face_detected INTEGER NOT NULL DEFAULT 0,
                    reaction TEXT NOT NULL DEFAULT 'Unknown',
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(student_id, attendance_date, period_number)
                )
                """
            )
            connection.execute(
                f"""
                INSERT INTO attendance (
                    id, student_id, name, department, attendance_date,
                    period_number, day_name, month_name, year, check_in_time,
                    status, face_detected, reaction, created_at
                )
                SELECT id, student_id, name, department, attendance_date,
                       {legacy_period}, day_name, month_name, year, check_in_time,
                       status, face_detected, reaction, created_at
                FROM attendance_legacy
                """
            )
            connection.execute("DROP TABLE attendance_legacy")

        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(attendance_date)"
        )


def get_period(now: datetime) -> int | None:
    """Return the active class period number, or None during a break/off hours."""
    minutes_since_midnight = now.hour * 60 + now.minute
    return next(
        (number for number, start, end in PERIODS if start <= minutes_since_midnight < end),
        None,
    )


def validate_text(value: Any, field_name: str) -> str:
    """Return a cleaned required string or raise a useful validation error."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} is required.")
    return value.strip()


def detect_face(image_data: str | None) -> tuple[bool, str]:
    """Detect a face when OpenCV and a camera image are available.

    The browser UI can still record attendance without OpenCV. In production,
    install opencv-python and replace the reaction placeholder with a trained
    emotion model if actual facial-expression classification is required.
    """
    if not image_data or cv2 is None or np is None:
        return False, "Browser camera"

    try:
        encoded_image = image_data.split(",", 1)[-1]
        image_bytes = base64.b64decode(encoded_image)
        image_array = np.frombuffer(image_bytes, dtype=np.uint8)
        image = cv2.imdecode(image_array, cv2.IMREAD_COLOR)
        if image is None:
            return False, "Invalid image"

        gray_image = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        detector = cv2.CascadeClassifier(
            cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        )
        faces = detector.detectMultiScale(
            gray_image,
            scaleFactor=1.1,
            minNeighbors=5,
            minSize=(80, 80),
        )
        return bool(len(faces)), "Detected" if len(faces) else "No face"
    except (ValueError, TypeError, base64.binascii.Error, cv2.error):
        return False, "Invalid image"


def serialize_attendance(row: sqlite3.Row) -> dict[str, Any]:
    """Map database column names to the frontend API contract."""
    return {
        "id": row["id"],
        "student_id": row["student_id"],
        "name": row["name"],
        "department": row["department"],
        "date": row["attendance_date"],
        "period_number": row["period_number"],
        "day": row["day_name"],
        "month": row["month_name"],
        "year": row["year"],
        "time": row["check_in_time"],
        "check_in": row["check_in_time"],
        "status": row["status"],
        "face_detected": bool(row["face_detected"]),
        "reaction": row["reaction"],
    }


@app.get("/")
def home():
    return render_template("index.html")


@app.get("/css/<path:filename>")
def css_file(filename: str):
    return send_from_directory(CSS_DIR, filename)


@app.get("/java-script/<path:filename>")
@app.get("/java script/<path:filename>")
def javascript_file(filename: str):
    return send_from_directory(JAVASCRIPT_DIR, filename)


@app.get("/api/students")
def get_students():
    with get_connection() as connection:
        rows = connection.execute(
            "SELECT student_id, name, department FROM students ORDER BY name"
        ).fetchall()
    return jsonify([dict(row) for row in rows])


@app.post("/api/verify-face")
def verify_face():
    data = request.get_json(silent=True) or {}
    image = data.get("image")
    if not isinstance(image, str) or not image:
        return jsonify({"error": "A camera image is required for face verification."}), 400
    if cv2 is None or np is None:
        return jsonify({"error": "Face verification is unavailable. Install the Python requirements."}), 503

    face_detected, face_result = detect_face(image)
    if not face_detected:
        return jsonify({"error": "No face detected. Center your face in the camera and try again."}), 422
    return jsonify({"verified": True, "face_result": face_result})


@app.post("/api/students")
def register_student():
    data = request.get_json(silent=True) or {}
    try:
        student_id = validate_text(data.get("student_id"), "Student ID")
        name = validate_text(data.get("name"), "Name")
        department = str(data.get("department") or "New student").strip()
    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    try:
        with get_connection() as connection:
            connection.execute(
                "INSERT INTO students (student_id, name, department) VALUES (?, ?, ?)",
                (student_id, name, department),
            )
    except sqlite3.IntegrityError:
        return jsonify({"error": "That student ID already exists."}), 409

    return jsonify({"message": "Student registered successfully.", "student_id": student_id}), 201


@app.get("/api/attendance")
def get_attendance():
    date = request.args.get("date")
    month = request.args.get("month")
    query = "SELECT * FROM attendance"
    conditions = []
    parameters: list[Any] = []

    if date:
        conditions.append("attendance_date = ?")
        parameters.append(date)
    elif month:
        conditions.append("attendance_date LIKE ?")
        parameters.append(f"{month}%")
    else:
        start_date = request.args.get("start_date")
        end_date = request.args.get("end_date")
        if start_date:
            conditions.append("attendance_date >= ?")
            parameters.append(start_date)
        if end_date:
            conditions.append("attendance_date <= ?")
            parameters.append(end_date)

    period = request.args.get("period")
    if period:
        try:
            period_number = int(period)
        except ValueError:
            return jsonify({"error": "Period must be between 1 and 5."}), 400
        if not 1 <= period_number <= 5:
            return jsonify({"error": "Period must be between 1 and 5."}), 400
        conditions.append("period_number = ?")
        parameters.append(period_number)

    if conditions:
        query += " WHERE " + " AND ".join(conditions)
    query += " ORDER BY attendance_date DESC, id DESC"
    with get_connection() as connection:
        rows = connection.execute(query, parameters).fetchall()
    return jsonify([serialize_attendance(row) for row in rows])


@app.post("/api/attendance")
def mark_attendance():
    data = request.get_json(silent=True) or {}
    try:
        student_id = validate_text(data.get("student_id"), "Student ID")
        submitted_name = validate_text(data.get("name"), "Name")
    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    now = datetime.now()
    period_number = get_period(now)
    if period_number is None:
        if 12 * 60 <= now.hour * 60 + now.minute < 13 * 60:
            message = "Attendance cannot be marked during the 12:00 PM–1:00 PM lunch break."
        else:
            message = "Attendance can only be marked during a class period from 9:00 AM to 3:00 PM."
        return jsonify({"error": message}), 400

    image = data.get("image")
    if not image:
        return jsonify({"error": "Start the camera and capture a face before marking attendance."}), 400

    face_detected, face_result = detect_face(image)
    if not face_detected:
        return jsonify({"error": f"Face verification failed: {face_result}."}), 422

    reaction = str(data.get("reaction") or "Unknown").strip()
    attendance_date = now.strftime("%Y-%m-%d")
    status = "Present"

    with get_connection() as connection:
        student = connection.execute(
            "SELECT name, department FROM students WHERE student_id = ?",
            (student_id,),
        ).fetchone()

        name = student["name"] if student else submitted_name
        department = student["department"] if student else "New student"

        if student is None:
            connection.execute(
                "INSERT OR IGNORE INTO students (student_id, name, department) VALUES (?, ?, ?)",
                (student_id, name, department),
            )

        for missed_period, _, _ in PERIODS[: period_number - 1]:
            connection.execute(
                """
                INSERT OR IGNORE INTO attendance (
                    student_id, name, department, attendance_date, day_name,
                    period_number, month_name, year, check_in_time, status,
                    face_detected, reaction
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Absent', 0, 'Unknown')
                """,
                (
                    student_id,
                    name,
                    department,
                    attendance_date,
                    now.strftime("%A"),
                    missed_period,
                    now.strftime("%B"),
                    now.year,
                    "Not marked",
                ),
            )

        try:
            cursor = connection.execute(
                """
                INSERT INTO attendance (
                    student_id, name, department, attendance_date, day_name,
                    period_number, month_name, year, check_in_time, status,
                    face_detected, reaction
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    student_id,
                    name,
                    department,
                    attendance_date,
                    now.strftime("%A"),
                    period_number,
                    now.strftime("%B"),
                    now.year,
                    now.strftime("%I:%M:%S %p"),
                    status,
                    int(face_detected),
                    reaction,
                ),
            )
        except sqlite3.IntegrityError:
            return jsonify({
                "error": f"Attendance is already marked for {student_id} in period {period_number} today."
            }), 409

        saved = connection.execute(
            "SELECT * FROM attendance WHERE id = ?", (cursor.lastrowid,)
        ).fetchone()

    return jsonify({
        "message": f"Attendance marked for period {period_number} at {saved['check_in_time']}.",
        "face_detected": face_detected,
        "face_result": face_result,
        "record": serialize_attendance(saved),
    }), 201


@app.get("/api/current-period")
def current_period():
    now = datetime.now()
    period_number = get_period(now)
    if period_number is None:
        on_lunch_break = 12 <= now.hour < 13
        return jsonify({
            "period_number": None,
            "label": "Lunch break" if on_lunch_break else "Outside college hours",
            "start": None,
            "end": None,
        })

    _, start, end = PERIODS[period_number - 1]
    return jsonify({
        "period_number": period_number,
        "label": f"Period {period_number}",
        "start": datetime.strptime(f"{start // 60:02d}:{start % 60:02d}", "%H:%M").strftime("%I:%M %p"),
        "end": datetime.strptime(f"{end // 60:02d}:{end % 60:02d}", "%H:%M").strftime("%I:%M %p"),
    })


@app.get("/api/stats")
def get_stats():
    today = datetime.now().strftime("%Y-%m-%d")
    month = request.args.get("month", today[:7])

    with get_connection() as connection:
        total_students = connection.execute("SELECT COUNT(*) FROM students").fetchone()[0]
        today_present = connection.execute(
            "SELECT COUNT(DISTINCT student_id) FROM attendance WHERE attendance_date = ? AND status != 'Absent'",
            (today,),
        ).fetchone()[0]
        today_late = connection.execute(
            "SELECT COUNT(DISTINCT student_id) FROM attendance WHERE attendance_date = ? AND status = 'Late'",
            (today,),
        ).fetchone()[0]
        month_records = connection.execute(
            "SELECT status, COUNT(*) AS total FROM attendance WHERE attendance_date LIKE ? GROUP BY status",
            (f"{month}%",),
        ).fetchall()

    monthly_counts = {row["status"].lower(): row["total"] for row in month_records}
    percentage = round((today_present / total_students) * 100, 2) if total_students else 0

    return jsonify({
        "total_students": total_students,
        "today_present": today_present,
        "today_absent": max(0, total_students - today_present),
        "today_late": today_late,
        "attendance_percentage": percentage,
        "month": month,
        "monthly_counts": monthly_counts,
    })


@app.errorhandler(404)
def not_found(error):
    return jsonify({"error": "The requested resource was not found."}), 404


init_database()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False, use_reloader=False)
