const STORAGE_KEYS = {
  students: 'attendly-students',
  records: 'attendly-records'
};

const AVATAR_COLORS = [
  'avatar-purple',
  'avatar-blue',
  'avatar-pink',
  'avatar-yellow',
  'avatar-green',
  'avatar-sky'
];

const CLASS_PERIODS = [
  { number: 1, start: 9 * 60, end: 10 * 60, label: '9:00 AM – 10:00 AM' },
  { number: 2, start: 10 * 60, end: 11 * 60, label: '10:00 AM – 11:00 AM' },
  { number: 3, start: 11 * 60, end: 12 * 60, label: '11:00 AM – 12:00 PM' },
  { number: 4, start: 13 * 60, end: 14 * 60, label: '1:00 PM – 2:00 PM' },
  { number: 5, start: 14 * 60, end: 15 * 60, label: '2:00 PM – 3:00 PM' }
];

const defaultStudents = [
  { name: 'Maya Patel', studentId: 'STU-001', department: 'Class 10-A', color: 'avatar-purple' },
  { name: 'Noah Williams', studentId: 'STU-002', department: 'Class 10-A', color: 'avatar-blue' },
  { name: 'Priya Shah', studentId: 'STU-003', department: 'Class 11-A', color: 'avatar-pink' },
  { name: 'Ethan Brooks', studentId: 'STU-004', department: 'Computer Science', color: 'avatar-yellow' },
  { name: 'Sofia Garcia', studentId: 'STU-005', department: 'Class 12-A', color: 'avatar-green' }
];

const defaultRecords = [
  { studentId: 'STU-001', name: 'Maya Patel', department: 'Class 10-A', date: '2026-09-24', time: '08:42 AM', status: 'Present', reaction: 'Happy' },
  { studentId: 'STU-002', name: 'Noah Williams', department: 'Class 10-A', date: '2026-09-24', time: '08:51 AM', status: 'Present', reaction: 'Focused' },
  { studentId: 'STU-003', name: 'Priya Shah', department: 'Class 11-A', date: '2026-09-24', time: '09:17 AM', status: 'Late', reaction: 'Neutral' },
  { studentId: 'STU-004', name: 'Ethan Brooks', department: 'Computer Science', date: '2026-09-23', time: '08:38 AM', status: 'Present', reaction: 'Happy' }
];

const students = loadData(STORAGE_KEYS.students, defaultStudents);
const records = loadData(STORAGE_KEYS.records, defaultRecords);
let cameraStream = null;
let faceVerified = false;
let checkinInProgress = false;
let toastTimer;
let periodReportRecords = [];

function getElement(selector) {
  return document.querySelector(selector);
}

function loadData(key, fallback) {
  try {
    const savedData = JSON.parse(localStorage.getItem(key));
    return Array.isArray(savedData) ? savedData : fallback.map((item) => ({ ...item }));
  } catch {
    return fallback.map((item) => ({ ...item }));
  }
}

function saveData() {
  localStorage.setItem(STORAGE_KEYS.students, JSON.stringify(students));
  localStorage.setItem(STORAGE_KEYS.records, JSON.stringify(records));
}

function getAttendanceKey(record) {
  return [
    record.student_id || record.studentId,
    record.date,
    record.period_number ?? record.periodNumber ?? 'unassigned'
  ].join(':').toLowerCase();
}

function mergeAttendanceRecords(serverRecords, localRecords) {
  const merged = new Map();
  [...serverRecords, ...localRecords].forEach((record) => {
    const key = getAttendanceKey(record);
    if (!merged.has(key)) merged.set(key, record);
  });
  return [...merged.values()].sort((first, second) =>
    `${second.date} ${second.time}`.localeCompare(`${first.date} ${first.time}`)
  );
}

async function loadServerData() {
  try {
    const [studentResponse, attendanceResponse] = await Promise.all([
      fetch('/api/students'),
      fetch('/api/attendance')
    ]);
    if (!studentResponse.ok || !attendanceResponse.ok) {
      throw new Error('Attendance service returned an error.');
    }

    const [serverStudents, serverRecords] = await Promise.all([
      studentResponse.json(),
      attendanceResponse.json()
    ]);
    const localStudents = [...students];
    const registeredStudents = serverStudents.map((student, index) => ({
      name: student.name,
      studentId: student.student_id,
      department: student.department,
      color: getStudentById(student.student_id)?.color || AVATAR_COLORS[index % AVATAR_COLORS.length]
    }));
    const serverIds = new Set(registeredStudents.map((student) => student.studentId.toLowerCase()));
    students.splice(0, students.length, ...registeredStudents,
      ...localStudents.filter((student) => !serverIds.has(student.studentId.toLowerCase())));

    const normalizedRecords = serverRecords.map((record) => ({
      studentId: record.student_id,
      name: record.name,
      department: record.department,
      date: record.date,
      time: record.time,
      periodNumber: record.period_number,
      status: record.status,
      reaction: record.reaction,
      faceDetected: record.face_detected
    }));
    records.splice(0, records.length, ...mergeAttendanceRecords(normalizedRecords, records));
    saveData();
  } catch (error) {
    showToast(error.message || 'Could not connect to the attendance server.');
  }
}

function getTodayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getCurrentPeriod(date = new Date()) {
  const minutesSinceMidnight = date.getHours() * 60 + date.getMinutes();
  return CLASS_PERIODS.find((period) => minutesSinceMidnight >= period.start && minutesSinceMidnight < period.end) || null;
}

function isWithinCollegeHours(date) {
  return Boolean(getCurrentPeriod(date));
}

function updateCheckinAvailability() {
  getElement('#checkinButton').disabled = !getCurrentPeriod() || !faceVerified || checkinInProgress;
}

function updateCurrentPeriodLabel() {
  const period = getCurrentPeriod();
  const label = getElement('#currentPeriodLabel');
  const checkinButton = getElement('#checkinButton');

  if (period) {
    label.textContent = `Period ${period.number} · ${period.label}`;
  } else {
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    label.textContent = minutes >= 12 * 60 && minutes < 13 * 60
      ? 'Lunch break · attendance paused'
      : 'Outside class hours · attendance paused';
  }

  updateCheckinAvailability();
}

function updateDashboardDateTime() {
  const now = new Date();
  const date = now.toLocaleDateString('en', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });
  const time = now.toLocaleTimeString('en', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  });
  const dateTime = getElement('#dashboardDateTime');
  dateTime.dateTime = now.toISOString();
  dateTime.textContent = `${date} · ${time}`;
}

function getInitials(name) {
  return name
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function getReactionEmoji(reaction) {
  return { Happy: '😊', Neutral: '😐', Focused: '🙂' }[reaction] || '🙂';
}

function submitLogin(event) {
  event.preventDefault();
  const nameInput = getElement('#loginName');
  const passwordInput = getElement('#loginPassword');
  const name = nameInput.value.trim();
  const password = passwordInput.value;
  const nameError = getElement('#loginNameError');
  const passwordError = getElement('#loginPasswordError');

  nameError.textContent = name ? '' : 'Name is required.';
  passwordError.textContent = password ? '' : 'Password is required.';
  nameInput.setAttribute('aria-invalid', String(!name));
  passwordInput.setAttribute('aria-invalid', String(Boolean(passwordError.textContent)));

  if (!name || passwordError.textContent) {
    (name ? passwordInput : nameInput).focus();
    return;
  }

  getElement('#welcomeHeading').textContent = `Good morning, ${name}.`;
  getElement('.user-card strong').textContent = name;
  getElement('#loginPage').hidden = true;
  getElement('#appShell').hidden = false;
}

function logoutUser() {
  if (cameraStream) {
    stopCamera();
  }
  getElement('#loginPassword').value = '';
  getElement('#loginPasswordError').textContent = '';
  getElement('#loginPassword').setAttribute('aria-invalid', 'false');
  getElement('#loginPage').hidden = false;
  getElement('#appShell').hidden = true;
  getElement('#loginName').focus();
}

function showToast(message) {
  const toast = getElement('#toast');
  toast.querySelector('span').textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2600);
}

function renderStats() {
  const today = getTodayKey();
  const todayRecords = records.filter((record) => record.date === today);
  const presentStudents = new Set(todayRecords
    .filter((record) => record.status !== 'Absent')
    .map((record) => (record.student_id || record.studentId).toLowerCase()));
  const lateStudents = new Set(todayRecords
    .filter((record) => (record.arrivalStatus || record.status) === 'Late')
    .map((record) => (record.student_id || record.studentId).toLowerCase()));
  const present = presentStudents.size;
  const late = lateStudents.size;
  const absent = Math.max(0, students.length - present);
  const percentage = students.length ? Math.round((present / students.length) * 100) : 0;

  getElement('#totalStudents').textContent = students.length;
  getElement('#presentCount').textContent = present;
  getElement('#absentCount').textContent = absent;
  getElement('#lateCount').textContent = late;
  getElement('#attendanceRate').textContent = `${percentage}%`;
  getElement('#navPresent').textContent = present;
  getElement('#attendanceDelta').textContent = todayRecords.length
    ? `${todayRecords.length} check-in${todayRecords.length === 1 ? '' : 's'} recorded`
    : 'No records yet';

  getElement('#miniBars').innerHTML = Array.from({ length: 8 }, (_, index) =>
    `<i style="height: ${18 + ((index * 17) % 43)}px"></i>`
  ).join('');
}

function renderMonthOptions() {
  const currentMonth = getTodayKey().slice(0, 7);
  const months = [...new Set(records.map((record) => record.date.slice(0, 7)))];

  if (!months.includes(currentMonth)) {
    months.unshift(currentMonth);
  }

  getElement('#monthFilter').innerHTML = months
    .sort((first, second) => second.localeCompare(first))
    .map((month) => {
      const label = new Date(`${month}-15T12:00:00`).toLocaleString('en', {
        month: 'long',
        year: 'numeric'
      });
      return `<option value="${month}">${label}</option>`;
    })
    .join('');

  getElement('#monthFilter').value = currentMonth;
}

function renderChart() {
  const selectedMonth = getElement('#monthFilter').value;
  const year = Number(selectedMonth.slice(0, 4));
  const month = Number(selectedMonth.slice(5, 7));
  const daysInMonth = new Date(year, month, 0).getDate();
  const daysToShow = Array.from({ length: daysInMonth }, (_, index) => index + 1)
    .filter((day) => day % 3 === 0 || records.some((record) => record.date === `${selectedMonth}-${String(day).padStart(2, '0')}`));

  getElement('#attendanceChart').innerHTML = daysToShow.length
    ? daysToShow.map((day) => {
      const date = `${selectedMonth}-${String(day).padStart(2, '0')}`;
      const present = new Set(records
        .filter((record) => record.date === date && record.status !== 'Absent')
        .map((record) => (record.student_id || record.studentId).toLowerCase())).size;
      const absent = Math.max(0, students.length - present);
      const presentHeight = present ? Math.max(12, (present / Math.max(students.length, 1)) * 100) : 3;
      const absentHeight = absent ? Math.max(7, (absent / Math.max(students.length, 1)) * 55) : 3;

      return `<div class="chart-column">
        <div class="bar-stack">
          <i class="bar present-bar" style="height: ${presentHeight}%" title="${present} present"></i>
          <i class="bar absent-bar" style="height: ${absentHeight}%" title="${absent} absent"></i>
        </div>
        <label>${day}</label>
      </div>`;
    }).join('')
    : '<span>No records for this month</span>';

  const monthRecords = records.filter((record) => record.date.startsWith(selectedMonth));
  getElement('#chartNote').textContent = `${monthRecords.length} record${monthRecords.length === 1 ? '' : 's'}`;
}

function renderActivity(searchTerm = '') {
  const query = searchTerm.trim().toLowerCase();
  const filteredRecords = records
    .filter((record) => [record.name, record.student_id || record.studentId, record.department]
      .some((value) => String(value || '').toLowerCase().includes(query)))
    .sort((first, second) => `${second.date} ${second.time}`.localeCompare(`${first.date} ${first.time}`));
  const today = getTodayKey();

  getElement('#activityTable').innerHTML = filteredRecords.length
    ? filteredRecords.slice(0, 10).map((record) => {
      const student = students.find((item) => item.studentId === record.studentId);
      const color = student?.color || 'avatar-teal';
      const checkIn = record.date === today ? record.time : `${record.date} · ${record.time}`;
      const statusClass = record.status.toLowerCase().replaceAll(' ', '-');
      const checkoutAction = record.date === today && !record.checkOutTime
        ? `<button class="checkout-button" data-checkout-id="${escapeHtml(record.studentId)}" data-checkout-period="${record.periodNumber ?? ''}">Check out</button>`
        : '—';
      return `<tr>
        <td><div class="person-cell"><div class="avatar ${color}">${escapeHtml(getInitials(record.name))}</div>${escapeHtml(record.name)}</div></td>
        <td>${escapeHtml(record.studentId)}</td>
        <td>${escapeHtml(record.department)}</td>
        <td>${record.periodNumber ? `Period ${record.periodNumber}` : '—'}</td>
        <td>${escapeHtml(checkIn)}</td>
        <td>${escapeHtml(record.checkOutTime || '—')}</td>
        <td><span class="reaction" title="${escapeHtml(record.reaction)}">${getReactionEmoji(record.reaction)}</span></td>
        <td><span class="status-pill ${statusClass}">${escapeHtml(record.status)}</span></td>
        <td>${checkoutAction}</td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="9">No attendance records found.</td></tr>';
}

function renderAll() {
  renderStats();
  renderMonthOptions();
  renderChart();
  renderActivity(getElement('#studentSearch').value);
}

function getStudentById(studentId) {
  return students.find((student) => student.studentId.toLowerCase() === studentId.toLowerCase());
}

function captureCameraFrame() {
  const camera = getElement('#camera');
  if (!cameraStream || camera.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = camera.videoWidth;
  canvas.height = camera.videoHeight;
  canvas.getContext('2d').drawImage(camera, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

async function markAttendance() {
  const nameInput = getElement('#checkinName');
  const idInput = getElement('#checkinId');
  const name = nameInput.value.trim();
  const studentId = idInput.value.trim();

  if (!name || !studentId) {
    showToast('Enter the student name and ID');
    return;
  }

  const period = getCurrentPeriod();
  if (!period) {
    showToast('Attendance can only be recorded during a class period');
    return;
  }
  if (!faceVerified) {
    showToast('Verify your face with the camera before marking attendance');
    return;
  }

  const image = captureCameraFrame();
  if (!image) {
    showToast('Start the camera and position a face before marking attendance');
    return;
  }

  const checkinButton = getElement('#checkinButton');
  checkinInProgress = true;
  updateCheckinAvailability();
  try {
    const response = await fetch('/api/attendance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        student_id: studentId,
        name,
        image,
        reaction: getElement('#reactionSelect').value
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Attendance could not be recorded.');

    const saved = result.record;
    let student = getStudentById(saved.student_id);
    if (!student) {
      student = {
        name: saved.name,
        studentId: saved.student_id,
        department: saved.department,
        color: AVATAR_COLORS[students.length % AVATAR_COLORS.length]
      };
      students.push(student);
    }

    records.unshift({
      studentId: saved.student_id,
      name: saved.name,
      department: saved.department,
      date: saved.date,
      time: saved.time,
      periodNumber: saved.period_number,
      status: saved.status,
      reaction: saved.reaction,
      faceDetected: saved.face_detected
    });
    saveData();
    renderAll();
    nameInput.value = '';
    idInput.value = '';
    await loadPeriodReport();
    showToast(result.message);
  } catch (error) {
    showToast(error.message || 'Could not connect to the attendance server');
  } finally {
    checkinInProgress = false;
    updateCurrentPeriodLabel();
  }
}

function markCheckout(studentId, periodNumber) {
  const record = records.find((item) =>
    item.studentId === studentId && item.date === getTodayKey() && item.periodNumber === periodNumber
  );
  if (!record || record.checkOutTime) {
    showToast('Checkout is already recorded or attendance is missing');
    return;
  }

  if (!isWithinCollegeHours(new Date())) {
    showToast('Attendance can only be recorded between 9:00 AM and 3:00 PM');
    return;
  }

  record.arrivalStatus = record.arrivalStatus || record.status;
  record.checkOutTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  record.status = 'Checked out';
  saveData();
  renderAll();
  showToast(`${record.name} checked out at ${record.checkOutTime}`);
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    const message = window.isSecureContext
      ? 'Camera is unavailable in this browser.'
      : 'Open Attendly at http://127.0.0.1:5000 to allow camera access.';
    getElement('#cameraStatus').textContent = message;
    showToast(message);
    return;
  }

  const cameraButton = getElement('#cameraButton');
  cameraButton.disabled = true;
  getElement('#cameraStatus').textContent = 'Requesting camera permission...';
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user' },
      audio: false
    });
    const camera = getElement('#camera');
    camera.srcObject = cameraStream;
    camera.style.display = 'block';
    getElement('#cameraPlaceholder').style.display = 'none';
    await camera.play();
    cameraButton.textContent = 'Stop camera';
    getElement('#cameraStatus').textContent = 'Camera ready · checking for a face...';
    await verifyCameraFace();
  } catch (error) {
    cameraStream?.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    const messages = {
      NotAllowedError: 'Camera access was blocked. Allow camera permission in your browser settings.',
      NotFoundError: 'No camera was found. Connect a camera and try again.',
      NotReadableError: 'The camera is in use by another app. Close that app and try again.',
      OverconstrainedError: 'The requested camera is unavailable. Try another camera.',
      SecurityError: 'Camera access is blocked by browser security. Open Attendly at http://127.0.0.1:5000.'
    };
    const message = messages[error.name] || error.message || 'Could not start the camera. Check browser camera permissions.';
    getElement('#camera').srcObject = null;
    getElement('#camera').style.display = 'none';
    getElement('#cameraPlaceholder').style.display = 'flex';
    getElement('#cameraStatus').textContent = message;
    cameraButton.textContent = 'Start camera';
    showToast(message);
  } finally {
    cameraButton.disabled = false;
    updateCheckinAvailability();
  }
}

async function verifyCameraFace() {
  const cameraButton = getElement('#cameraButton');
  const image = captureCameraFrame();
  if (!image) {
    faceVerified = false;
    getElement('#cameraStatus').textContent = 'Camera frame unavailable. Check that the video is playing.';
    cameraButton.textContent = 'Stop camera';
    updateCheckinAvailability();
    return;
  }

  faceVerified = false;
  cameraButton.disabled = true;
  cameraButton.textContent = 'Checking face...';
  getElement('#cameraStatus').textContent = 'Verifying face...';
  updateCheckinAvailability();

  try {
    const response = await fetch('/api/verify-face', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Face verification failed.');

    faceVerified = true;
    getElement('#reactionSelect').value = 'Happy';
    getElement('#cameraStatus').textContent = 'Face verified · Happy reaction selected';
    cameraButton.textContent = 'Stop camera';
    showToast('Face verified. Attendance is ready.');
  } catch (error) {
    faceVerified = false;
    getElement('#cameraStatus').textContent = error.message.includes('Failed to fetch')
      ? 'Face verification server unavailable. Check that Flask is running.'
      : error.message;
    cameraButton.textContent = 'Stop camera';
  } finally {
    cameraButton.disabled = false;
    updateCheckinAvailability();
  }
}

function stopCamera() {
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  faceVerified = false;
  getElement('#camera').style.display = 'none';
  getElement('#camera').srcObject = null;
  getElement('#cameraPlaceholder').style.display = 'flex';
  getElement('#cameraButton').textContent = 'Start camera';
  getElement('#cameraStatus').textContent = 'Ready for check-in';
  updateCheckinAvailability();
}

function downloadCsv(sourceRecords = records) {
  const rows = [
    ['USN', 'Name', 'Class', 'Date', 'Period', 'Check-in time', 'Check-out time', 'Status', 'Face reaction'],
    ...sourceRecords.map((record) => [record.student_id || record.studentId, record.name, record.department || '', record.date, record.period_number ?? record.periodNumber ?? '', record.time, record.checkOutTime || '', record.status, record.reaction])
  ];
  const csv = rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  link.download = 'period-attendance-report.csv';
  link.click();
  URL.revokeObjectURL(link.href);
  showToast('Attendance report downloaded');
}

function downloadExcel(sourceRecords = periodReportRecords) {
  const rows = [
    ['USN', 'Name', 'Class', 'Date', 'Period', 'Check-in time', 'Status', 'Face reaction'],
    ...sourceRecords.map((record) => [
      record.student_id || record.studentId,
      record.name,
      record.department || '',
      record.date,
      record.period_number ?? record.periodNumber ?? '',
      record.time,
      record.status,
      record.reaction
    ])
  ];
  const table = `<table>${rows.map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value ?? '')}</td>`).join('')}</tr>`).join('')}</table>`;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([`<html><meta charset="utf-8">${table}</html>`], {
    type: 'application/vnd.ms-excel'
  }));
  link.download = 'attendance-report.xls';
  link.click();
  URL.revokeObjectURL(link.href);
  showToast('Excel report downloaded');
}

function closeModal() {
  getElement('#modalBackdrop').classList.remove('open');
}

function updateReportRange() {
  const range = getElement('#reportRange').value;
  const monthly = range === 'monthly';
  getElement('#dailyReportDate').hidden = monthly;
  getElement('#monthlyReportMonth').hidden = !monthly;
}

function getDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

async function loadPeriodReport() {
  const range = getElement('#reportRange').value;
  const selectedValue = range === 'monthly'
    ? getElement('#monthlyReportMonth').value
    : getElement('#dailyReportDate').value;

  if (!selectedValue) {
    showToast(range === 'monthly' ? 'Choose a report month' : 'Choose a report date');
    return;
  }

  const params = new URLSearchParams();
  let startDate = selectedValue;
  let endDate = selectedValue;
  if (range === 'monthly') {
    params.set('month', selectedValue);
    startDate = `${selectedValue}-01`;
    const [year, month] = selectedValue.split('-').map(Number);
    endDate = getDateKey(new Date(year, month, 0));
  } else if (range === 'weekly') {
    const weekStart = new Date(`${selectedValue}T12:00:00`);
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    startDate = getDateKey(weekStart);
    endDate = getDateKey(weekEnd);
    params.set('start_date', startDate);
    params.set('end_date', endDate);
  } else {
    params.set('date', selectedValue);
  }

  try {
    const response = await fetch(`/api/attendance?${params}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not load this report.');
    const localRecords = records.filter((record) => record.date >= startDate && record.date <= endDate);
    periodReportRecords = mergeAttendanceRecords(result.map((record) => ({
      studentId: record.student_id,
      name: record.name,
      department: record.department,
      date: record.date,
      time: record.time,
      periodNumber: record.period_number,
      status: record.status,
      reaction: record.reaction,
      faceDetected: record.face_detected
    })), localRecords);

    const periodCounts = new Map(CLASS_PERIODS.map((period) => [period.number, { present: 0, absent: 0 }]));
    periodReportRecords.forEach((record) => {
      if (periodCounts.has(record.periodNumber)) {
        const counts = periodCounts.get(record.periodNumber);
        counts[record.status === 'Absent' ? 'absent' : 'present'] += 1;
      }
    });
    getElement('#periodReportSummary').innerHTML = CLASS_PERIODS.map((period) =>
      `<div class="period-summary-item"><strong>Period ${period.number}</strong><span>${periodCounts.get(period.number).present} present · ${periodCounts.get(period.number).absent} absent</span></div>`
    ).join('');
    getElement('#periodReportTable').innerHTML = periodReportRecords.length
      ? periodReportRecords.map((record) => `<tr>
        <td>${escapeHtml(record.date)}</td>
        <td>${record.periodNumber ? `Period ${record.periodNumber}` : 'Unassigned'}</td>
        <td>${escapeHtml(record.name)}</td>
        <td>${escapeHtml(record.studentId)}</td>
        <td>${escapeHtml(record.time)}</td>
        <td>${escapeHtml(record.status)}</td>
        <td>${record.faceDetected ? 'Detected' : 'Not detected'}</td>
      </tr>`).join('')
      : '<tr><td colspan="7">No attendance records for this selection.</td></tr>';
  } catch (error) {
    periodReportRecords = [];
    getElement('#periodReportSummary').replaceChildren();
    getElement('#periodReportTable').innerHTML = `<tr><td colspan="7">${escapeHtml(error.message || 'Start the Flask server to load saved reports.')}</td></tr>`;
  }
}

getElement('#cameraButton').addEventListener('click', () => {
  if (!cameraStream) {
    startCamera();
  } else {
    stopCamera();
  }
});
getElement('#loginForm').addEventListener('submit', submitLogin);
getElement('#logoutButton').addEventListener('click', logoutUser);
getElement('#loginName').addEventListener('input', () => {
  getElement('#loginNameError').textContent = '';
  getElement('#loginName').setAttribute('aria-invalid', 'false');
});
getElement('#loginPassword').addEventListener('input', () => {
  getElement('#loginPasswordError').textContent = '';
  getElement('#loginPassword').setAttribute('aria-invalid', 'false');
});
getElement('#sidebarCamera').addEventListener('click', () => {
  getElement('#attendance').scrollIntoView({ behavior: 'smooth' });
  startCamera();
});
getElement('#checkinButton').addEventListener('click', markAttendance);
getElement('#activityTable').addEventListener('click', (event) => {
  const checkoutButton = event.target.closest('[data-checkout-id]');
  if (checkoutButton) {
    const periodNumber = Number(checkoutButton.dataset.checkoutPeriod) || null;
    markCheckout(checkoutButton.dataset.checkoutId, periodNumber);
  }
});
getElement('#monthFilter').addEventListener('change', renderChart);
getElement('#studentSearch').addEventListener('input', (event) => renderActivity(event.target.value));
getElement('#exportButton').addEventListener('click', downloadCsv);
getElement('#reportRange').addEventListener('change', updateReportRange);
getElement('#loadPeriodReport').addEventListener('click', loadPeriodReport);
getElement('#reportButton').addEventListener('click', () => downloadCsv(periodReportRecords));
getElement('#excelReportButton').addEventListener('click', () => downloadExcel(periodReportRecords));
getElement('#pdfReportButton').addEventListener('click', () => window.print());
getElement('#viewAllButton').addEventListener('click', () => {
  getElement('#students').scrollIntoView({ behavior: 'smooth' });
  getElement('#studentSearch').focus();
});
getElement('#addStudentButton').addEventListener('click', () => getElement('#modalBackdrop').classList.add('open'));
getElement('#closeModal').addEventListener('click', closeModal);
getElement('#cancelModal').addEventListener('click', closeModal);
getElement('#modalBackdrop').addEventListener('click', (event) => {
  if (event.target === getElement('#modalBackdrop')) closeModal();
});
getElement('#studentForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const name = form.get('name').trim();
  const studentId = form.get('studentId').trim();
  const department = form.get('department').trim();

  if (getStudentById(studentId)) {
    showToast('That student ID already exists');
    return;
  }

  try {
    const response = await fetch('/api/students', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, student_id: studentId, department })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Student could not be saved.');
  } catch (error) {
    showToast(error.message || 'Could not connect to the attendance server.');
    return;
  }

  students.unshift({
    name,
    studentId,
    department,
    color: AVATAR_COLORS[students.length % AVATAR_COLORS.length]
  });
  saveData();
  renderAll();
  event.target.reset();
  closeModal();
  showToast(`${name} added to the directory`);
});

window.addEventListener('beforeunload', stopCamera);
updateDashboardDateTime();
window.setInterval(updateDashboardDateTime, 1000);
updateCurrentPeriodLabel();
window.setInterval(updateCurrentPeriodLabel, 15000);
getElement('#dailyReportDate').value = getTodayKey();
getElement('#monthlyReportMonth').value = getTodayKey().slice(0, 7);
updateReportRange();
renderAll();
loadPeriodReport();
loadServerData().then(() => {
  renderAll();
  loadPeriodReport();
});
