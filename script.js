  const schoolYear = String(values.get("schoolYear")).trim();
  const [start, end] = schoolYear.split("-").map(Number);
  const subjects = String(values.get("subjects")).split(/\r?\n/)
    .map((subject) => subject.trim()).filter(Boolean);

  if (!/^\d{4}-\d{4}$/.test(schoolYear) || end !== start + 1) {
    message("enrollment-message", "Enter consecutive school years, such as 2026-2027.");
    return;
  }
  if (enrollmentSubjectDetails.length !== subjects.length ||
      !subjects.length || subjects.length > 15 ||
      subjects.some((subject) => subject.length > 120) ||
      new Set(subjects.map((subject) => subject.toLowerCase())).size !== subjects.length) {
    message("enrollment-message", "Enter 1–15 unique subjects, up to 120 characters each.");
    return;
  }

  savingEnrollment = true;
  enrollmentSubmit.disabled = true;

  try {
    const { error } = await cloud.client.from("student_enrollments").insert({
      student_record_id: values.get("student"),
      school_year: schoolYear,
      semester: values.get("semester"),
      year_level: Number(values.get("year")),
      subjects,
      subject_details: enrollmentSubjectDetails,
    });

    if (session !== staff) return;
    if (error) throw error;

    enrollmentForm.reset();
    message("enrollment-message", "Enrollment saved.");
    await loadEnrollments();
  } catch (error) {
    if (session === staff) {
      message("enrollment-message", error.code === "23505"
        ? "This student is already enrolled for that school year and semester."
        : cloudError(error));
    }
  } finally {
    savingEnrollment = false;
    enrollmentSubmit.disabled = !staff || !activeStudents().length;
  }
});
if (cloudMode) {
  startCloud();
} else {
  records = loadDemo();
  showPage();
  render();
}


// Data privacy acknowledgement on sign-in.
{
  const login = document.getElementById("sign-in-form");
  const agreement = document.getElementById("privacy-agreement");
  const error = document.getElementById("privacy-agreement-error");
  const policy = document.getElementById("privacy-policy-dialog");

  document.getElementById("open-privacy-policy").addEventListener("click", () => {
    policy.showModal();
  });

  function clearPrivacyError() {
    agreement.removeAttribute("aria-invalid");
    error.textContent = "";
    error.hidden = true;
  }

  agreement.addEventListener("change", clearPrivacyError);
  login.addEventListener("reset", clearPrivacyError);

  login.addEventListener("submit", (event) => {
    if (agreement.checked) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    agreement.setAttribute("aria-invalid", "true");
    error.textContent = "Agree to the Data Privacy Policy before signing in.";
    error.hidden = false;
    agreement.focus();
  }, true);
}

// Show or hide the password on the sign-in form.
{
  const password = document.getElementById("login-password");
  const toggle = document.getElementById("toggle-login-password");

  function setPasswordVisibility(visible) {
    password.type = visible ? "text" : "password";
    const label = visible ? "Hide password" : "Show password";
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
    toggle.dataset.visible = String(visible);
  }

  toggle.addEventListener("click", () => {
    setPasswordVisibility(password.type === "password");
  });

  password.form.addEventListener("reset", () => setPasswordVisibility(false));
}
