"use strict";

const MAX_FILE_SIZE = 15 * 1024 * 1024;
const SUPABASE_STATE = window.ELibrarySupabase;

let dbClient = SUPABASE_STATE ? SUPABASE_STATE.client : null;
let currentUser = null;
let currentProfile = null;
let libraryPapers = [];
let teacherSubmissions = [];
let managedAccounts = [];
let isUploading = false;

const $ = id => document.getElementById(id);

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[char]);
}

function formatBytes(bytes) {
    if (!Number.isFinite(Number(bytes)) || Number(bytes) < 0) {
        return "Unknown size";
    }

    const size = Number(bytes);
    if (size < 1024) return size + " bytes";
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " KB";
    return (size / (1024 * 1024)).toFixed(2) + " MB";
}

function getSafeFileName(name) {
    return String(name || "past-paper.pdf")
        .replace(/[\\/:*?"<>|]/g, "_")
        .slice(0, 150);
}

function showMessage(id, text, type) {
    const element = $(id);
    element.textContent = text;
    element.className = "message " + type;
}

function showUploadMessage(text, type) {
    showMessage("uploadMessage", text, type);
}

function showStudentUploadMessage(text, type) {
    showMessage("studentUploadMessage", text, type);
}

async function validatePdf(file) {
    if (!file) throw new Error("Select a PDF file.");
    if (file.size === 0) throw new Error("The selected file is empty.");
    if (file.size > MAX_FILE_SIZE) {
        throw new Error("The PDF is too large. Maximum size is 15 MB.");
    }

    const isPdfByType = file.type === "application/pdf";
    const isPdfByName = file.name.toLowerCase().endsWith(".pdf");
    if (!isPdfByType && !isPdfByName) {
        throw new Error("Only PDF files are allowed.");
    }

    let signature;
    try {
        const header = await file.slice(0, 5).arrayBuffer();
        signature = new TextDecoder().decode(header);
    } catch (error) {
        throw new Error("Unable to read this file. Please try another PDF.");
    }

    if (signature !== "%PDF-") {
        throw new Error("This file does not appear to be a valid PDF.");
    }
}

function makeStoragePath(userId, file) {
    return `${userId}/${crypto.randomUUID()}-${getSafeFileName(file.name)}`;
}

async function uploadPdfAndRecord(bucket, path, file, table, record) {
    const { error: uploadError } = await dbClient.storage
        .from(bucket)
        .upload(path, file, {
            contentType: "application/pdf",
            upsert: false
        });

    if (uploadError) throw uploadError;

    const { data, error: insertError } = await dbClient
        .from(table)
        .insert(record)
        .select("id")
        .single();

    if (insertError) {
        const { error: cleanupError } = await dbClient.storage
            .from(bucket)
            .remove([path]);

        if (cleanupError) {
            console.error("Could not remove the unreferenced uploaded file.", cleanupError);
        }

        throw insertError;
    }

    return data;
}

async function refreshLibrary() {
    const { data, error } = await dbClient
        .from("past_papers")
        .select(
            "id, title, subject, course, exam_body, year, description, storage_path, file_name, file_size, uploaded_at"
        )
        .order("year", { ascending: false })
        .order("title", { ascending: true });

    if (error) throw error;

    libraryPapers = data || [];
    updateStatistics(libraryPapers);
    updateFilters(libraryPapers);
    renderPapers(libraryPapers);
    renderAdminPapers(libraryPapers);
}

function updateStatistics(papers) {
    $("totalCount").textContent = papers.length;

    const subjects = new Set(
        papers.map(paper => String(paper.subject).trim().toLowerCase())
    );
    const years = new Set(papers.map(paper => String(paper.year)));

    $("subjectCount").textContent = subjects.size;
    $("yearCount").textContent = years.size;
}

function updateFilters(papers) {
    updateSelect(
        $("subjectFilter"),
        [...new Set(papers.map(paper => paper.subject).filter(Boolean))]
            .sort((a, b) => a.localeCompare(b)),
        "All subjects"
    );

    updateSelect(
        $("yearFilter"),
        [...new Set(papers.map(paper => String(paper.year)).filter(Boolean))]
            .sort((a, b) => Number(b) - Number(a)),
        "All years"
    );

    updateSelect(
        $("examFilter"),
        [...new Set(papers.map(paper => paper.exam_body).filter(Boolean))]
            .sort((a, b) => a.localeCompare(b)),
        "All examination bodies"
    );
}

function updateSelect(select, values, firstLabel) {
    const previous = select.value;

    select.innerHTML =
        `<option value="">${escapeHTML(firstLabel)}</option>` +
        values.map(value =>
            `<option value="${escapeHTML(value)}">${escapeHTML(value)}</option>`
        ).join("");

    if (values.includes(previous)) select.value = previous;
}

function renderPapers(papers) {
    const search = $("searchInput").value.trim().toLowerCase();
    const subject = $("subjectFilter").value;
    const year = $("yearFilter").value;
    const examBody = $("examFilter").value;

    const filtered = papers.filter(paper => {
        const searchable = [
            paper.title,
            paper.subject,
            paper.course,
            paper.exam_body,
            paper.year,
            paper.description,
            paper.file_name
        ].join(" ").toLowerCase();

        return searchable.includes(search) &&
            (!subject || paper.subject === subject) &&
            (!year || String(paper.year) === year) &&
            (!examBody || paper.exam_body === examBody);
    });

    $("resultsCount").textContent =
        `${filtered.length} paper${filtered.length === 1 ? "" : "s"} found`;

    if (!filtered.length) {
        $("paperList").innerHTML = `
            <div class="empty-state">
                <strong>No past papers found</strong>
                Try a different search or ask the administrator to upload papers.
            </div>`;
        return;
    }

    $("paperList").innerHTML = filtered.map(paper => `
        <article class="paper-card">
            <div class="pdf-icon">PDF</div>
            <h3>${escapeHTML(paper.title)}</h3>
            <p class="paper-meta"><strong>Subject:</strong> ${escapeHTML(paper.subject)}</p>
            <p class="paper-meta"><strong>Course:</strong> ${escapeHTML(paper.course)}</p>
            <p class="paper-meta"><strong>Exam body:</strong> ${escapeHTML(paper.exam_body)}</p>
            <p class="paper-meta"><strong>Year:</strong> ${escapeHTML(paper.year)}</p>
            <p class="paper-meta"><strong>File:</strong> ${escapeHTML(formatBytes(paper.file_size))}</p>
            ${paper.description ? `<p class="paper-description">${escapeHTML(paper.description)}</p>` : ""}
            <div class="paper-actions">
                <button class="primary-button" type="button"
                    data-action="preview" data-id="${escapeHTML(paper.id)}">Preview PDF</button>
                <button class="secondary-button" type="button"
                    data-action="download" data-id="${escapeHTML(paper.id)}">Download</button>
            </div>
        </article>
    `).join("");
}

function renderAdminPapers(papers) {
    const container = $("adminPaperList");

    if (!currentProfile || currentProfile.role !== "admin") {
        container.innerHTML = "";
        return;
    }

    if (!papers.length) {
        container.innerHTML = `
            <div class="empty-state">
                <strong>Your library is empty</strong>
                Upload your first PDF using the form.
            </div>`;
        return;
    }

    container.innerHTML = papers.map(paper => `
        <article class="admin-paper">
            <div>
                <h4>${escapeHTML(paper.title)}</h4>
                <p>${escapeHTML(paper.subject)} · ${escapeHTML(paper.year)}</p>
                <p>${escapeHTML(paper.exam_body)} · ${escapeHTML(formatBytes(paper.file_size))}</p>
                <p>${escapeHTML(paper.file_name)}</p>
                <div class="paper-actions">
                    <button class="secondary-button" type="button"
                        data-action="preview" data-id="${escapeHTML(paper.id)}">Preview</button>
                    <button class="secondary-button" type="button"
                        data-action="download" data-id="${escapeHTML(paper.id)}">Download</button>
                </div>
            </div>
            <button class="delete-button" type="button"
                data-action="delete" data-id="${escapeHTML(paper.id)}">Delete</button>
        </article>
    `).join("");
}

function renderStudentSubmissions(submissions) {
    const container = $("studentSubmissionList");

    if (!submissions.length) {
        container.innerHTML = `
            <div class="empty-state">
                <strong>No submissions found</strong>
                Your submitted work will appear here.
            </div>`;
        return;
    }

    container.innerHTML = submissions.map(submission => `
        <article class="admin-paper">
            <div>
                <h4>${escapeHTML(submission.title)}</h4>
                <p>${escapeHTML(submission.subject)} · ${escapeHTML(submission.created_at)}</p>
                <p>Status: ${escapeHTML(submission.status)}</p>
            </div>
            <button class="secondary-button" type="button"
                data-action="download-submission"
                data-path="${escapeHTML(submission.storage_path)}"
                data-file-name="${escapeHTML(submission.file_name)}">Download</button>
        </article>
    `).join("");
}

function updateTeacherFilters(submissions) {
    updateSelect(
        $("teacherSubjectFilter"),
        [...new Set(submissions.map(item => item.subject).filter(Boolean))]
            .sort((a, b) => a.localeCompare(b)),
        "All subjects"
    );
}

function renderTeacherSubmissions() {
    const search = $("teacherSearch").value.trim().toLowerCase();
    const subject = $("teacherSubjectFilter").value;
    const filtered = teacherSubmissions.filter(item => {
        const searchable = [
            item.student_name,
            item.admission_number,
            item.subject,
            item.title,
            item.file_name
        ].join(" ").toLowerCase();

        return searchable.includes(search) &&
            (!subject || item.subject === subject);
    });

    if (!filtered.length) {
        $("teacherSubmissionList").innerHTML = `
            <div class="empty-state">
                <strong>No submissions found</strong>
                Student uploads will appear here.
            </div>`;
        return;
    }

    $("teacherSubmissionList").innerHTML = filtered.map(item => `
        <article class="admin-paper">
            <div>
                <h4>${escapeHTML(item.title)}</h4>
                <p>${escapeHTML(item.student_name)} · ${escapeHTML(item.admission_number)}</p>
                <p>${escapeHTML(item.subject)} · ${escapeHTML(item.created_at)}</p>
                <p>Status: ${escapeHTML(item.status)}</p>
                <div class="paper-actions">
                    <button class="secondary-button" type="button"
                        data-action="download-submission"
                        data-path="${escapeHTML(item.storage_path)}"
                        data-file-name="${escapeHTML(item.file_name)}">Download PDF</button>
                    ${item.status === "pending" ? `
                        <button class="primary-button" type="button"
                            data-action="review-submission"
                            data-id="${escapeHTML(item.id)}">Mark reviewed</button>
                    ` : ""}
                </div>
            </div>
        </article>
    `).join("");
}

async function loadOwnSubmissions(admissionNumber) {
    if (!currentUser || !currentProfile || currentProfile.role !== "student") return;

    let query = dbClient
        .from("submissions")
        .select("id, student_name, admission_number, subject, title, storage_path, file_name, status, created_at")
        .eq("student_id", currentUser.id)
        .order("created_at", { ascending: false });

    if (admissionNumber) {
        query = query.eq("admission_number", admissionNumber);
    }

    const { data, error } = await query;
    if (error) throw error;
    renderStudentSubmissions(data || []);
}

async function loadTeacherSubmissions() {
    if (!currentProfile ||
        !["teacher", "admin"].includes(currentProfile.role)) {
        return;
    }

    const { data, error } = await dbClient
        .from("submissions")
        .select("id, student_name, admission_number, subject, title, storage_path, file_name, status, created_at")
        .order("created_at", { ascending: false });

    if (error) throw error;

    teacherSubmissions = data || [];
    updateTeacherFilters(teacherSubmissions);
    renderTeacherSubmissions();
}

async function handleAdminUpload(event) {
    event.preventDefault();

    if (isUploading) return;
    if (!currentUser || !currentProfile || currentProfile.role !== "admin") {
        window.location.href = "signin.html?role=admin";
        return;
    }

    const title = $("paperTitle").value.trim();
    const subject = $("paperSubject").value.trim();
    const course = $("paperCourse").value.trim();
    const examBody = $("paperExam").value;
    const year = Number($("paperYear").value);
    const description = $("paperDescription").value.trim();
    const file = $("paperFile").files[0];

    if (!title || !subject || !course || !examBody || !file) {
        showUploadMessage("Complete all required fields and select a PDF.", "error");
        return;
    }

    if (!Number.isInteger(year) || year < 1950 || year > 2100) {
        showUploadMessage("Enter a valid examination year.", "error");
        return;
    }

    try {
        await validatePdf(file);
    } catch (error) {
        showUploadMessage(error.message, "error");
        return;
    }

    isUploading = true;
    $("uploadButton").disabled = true;
    $("uploadButton").textContent = "Uploading...";

    const fileName = getSafeFileName(file.name);

    try {
        const storagePath = makeStoragePath(currentUser.id, file);
        await uploadPdfAndRecord(
            "past-papers",
            storagePath,
            file,
            "past_papers",
            {
                title,
                subject,
                course,
                exam_body: examBody,
                year,
                description,
                storage_path: storagePath,
                file_name: fileName,
                file_size: file.size,
                uploaded_by: currentUser.id
            }
        );

        $("uploadForm").reset();
        showUploadMessage("Past paper saved to Supabase.", "success");

        try {
            await refreshLibrary();
        } catch (error) {
            console.error(error);
            showUploadMessage(
                `Past paper was saved, but the library could not refresh: ${error.message}`,
                "error"
            );
        }
    } catch (error) {
        console.error(error);
        showUploadMessage(`Upload failed: ${error.message}`, "error");
    } finally {
        isUploading = false;
        $("uploadButton").disabled = false;
        $("uploadButton").textContent = "Upload Past Paper";
    }
}

async function handleStudentUpload(event) {
    event.preventDefault();

    if (isUploading) return;
    if (!currentUser || !currentProfile || currentProfile.role !== "student") {
        window.location.href = "signin.html?role=student";
        return;
    }

    const studentName = $("studentName").value.trim();
    const admissionNumber = $("studentAdmission").value.trim();
    const subject = $("submissionSubject").value.trim();
    const title = $("submissionTitle").value.trim();
    const file = $("submissionFile").files[0];

    if (!studentName || !admissionNumber || !subject || !title || !file) {
        showStudentUploadMessage("Complete all required fields and select a PDF.", "error");
        return;
    }

    try {
        await validatePdf(file);
    } catch (error) {
        showStudentUploadMessage(error.message, "error");
        return;
    }

    isUploading = true;
    const submitButton = $("studentUploadForm").querySelector('button[type="submit"]');
    submitButton.disabled = true;
    submitButton.textContent = "Submitting...";

    const fileName = getSafeFileName(file.name);

    try {
        const storagePath = makeStoragePath(currentUser.id, file);
        await uploadPdfAndRecord(
            "student-submissions",
            storagePath,
            file,
            "submissions",
            {
                student_id: currentUser.id,
                student_name: studentName,
                admission_number: admissionNumber,
                subject,
                title,
                storage_path: storagePath,
                file_name: fileName,
                file_size: file.size
            }
        );

        $("studentUploadForm").reset();
        showStudentUploadMessage("Your work was saved to Supabase.", "success");

        try {
            await loadOwnSubmissions("");
        } catch (error) {
            console.error(error);
            showStudentUploadMessage(
                `Your work was saved, but submissions could not refresh: ${error.message}`,
                "error"
            );
        }
    } catch (error) {
        console.error(error);
        showStudentUploadMessage(`Submission failed: ${error.message}`, "error");
    } finally {
        isUploading = false;
        submitButton.disabled = false;
        submitButton.textContent = "Submit Work";
    }
}

async function downloadFromStorage(bucket, path, fileName) {
    const { data, error } = await dbClient.storage.from(bucket).download(path);
    if (error) throw error;

    const url = URL.createObjectURL(data);
    const link = document.createElement("a");
    link.href = url;
    link.download = getSafeFileName(fileName);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function downloadPaper(id) {
    const paper = libraryPapers.find(item => item.id === id);
    if (!paper) throw new Error("This paper is no longer in the library.");

    await downloadFromStorage("past-papers", paper.storage_path, paper.file_name);
}

async function downloadSubmission(path, fileName) {
    await downloadFromStorage("student-submissions", path, fileName);
}

function closePreview() {
    $("previewModal").hidden = true;
    $("pdfViewer").src = "about:blank";
    $("downloadLink").removeAttribute("href");
}

function previewPaper(id) {
    const paper = libraryPapers.find(item => item.id === id);
    if (!paper) throw new Error("This paper is no longer in the library.");

    const { data, error } = dbClient.storage
        .from("past-papers")
        .getPublicUrl(paper.storage_path);
    if (error) throw error;

    $("previewTitle").textContent = paper.title;
    $("previewDetails").textContent =
        `${paper.subject} · ${paper.exam_body} · ${paper.year}`;
    $("pdfViewer").src = data.publicUrl;
    $("downloadLink").href = data.publicUrl;
    $("downloadLink").download = getSafeFileName(paper.file_name);
    $("previewModal").hidden = false;
}

async function deletePaper(id) {
    if (!currentUser || !currentProfile || currentProfile.role !== "admin") {
        window.location.href = "signin.html?role=admin";
        return;
    }

    const paper = libraryPapers.find(item => item.id === id);
    if (!paper) throw new Error("This paper no longer exists.");

    if (!confirm(`Delete "${paper.title}" (${paper.year}) from the library?`)) {
        return;
    }

    const { error: deleteError } = await dbClient
        .from("past_papers")
        .delete()
        .eq("id", id);

    if (deleteError) throw deleteError;

    const { error: storageError } = await dbClient.storage
        .from("past-papers")
        .remove([paper.storage_path]);

    if (storageError) {
        console.error("Past-paper row was removed but its file remains in Storage.", storageError);
        alert(`Paper record deleted, but its PDF could not be removed: ${storageError.message}`);
    }

    await refreshLibrary();
}

async function reviewSubmission(id) {
    const { error } = await dbClient.rpc("mark_submission_reviewed", {
        submission_id: id
    });

    if (error) throw error;
    await loadTeacherSubmissions();
}

function showAdminAccountMessage(text, isError = false) {
    const message = $("adminAccountMessage");
    message.textContent = text;
    message.className = `message ${isError ? "error" : "success"}`;
}

function renderAdminAccounts() {
    const container = $("adminAccountList");
    const search = $("adminAccountSearch").value.trim().toLowerCase();
    const filtered = managedAccounts.filter(account => [
        account.full_name,
        account.email,
        account.admission_number,
        account.role
    ].some(value => String(value || "").toLowerCase().includes(search)));

    if (!filtered.length) {
        container.innerHTML = `
            <div class="empty-state">
                <strong>${managedAccounts.length ? "No matching accounts" : "No student or teacher accounts"}</strong>
                ${managedAccounts.length ? "Try a different search." : "Registered accounts will appear here."}
            </div>`;
        return;
    }

    container.innerHTML = filtered.map(account => `
        <article class="admin-account" data-account-id="${escapeHTML(account.id)}">
            <div class="admin-account-fields">
                <label>Full name
                    <input name="full_name" value="${escapeHTML(account.full_name)}" maxlength="100" required>
                </label>
                <label>Email
                    <input name="email" type="email" value="${escapeHTML(account.email)}" required>
                </label>
                <label>Admission number
                    <input name="admission_number" value="${escapeHTML(account.admission_number)}" maxlength="50">
                </label>
                <label>Role
                    <select name="role">
                        <option value="student" ${account.role === "student" ? "selected" : ""}>Student</option>
                        <option value="teacher" ${account.role === "teacher" ? "selected" : ""}>Teacher</option>
                    </select>
                </label>
            </div>
            <div class="admin-account-footer">
                <span class="account-status ${account.is_active ? "is-active" : "is-inactive"}">
                    ${account.is_active ? "Active" : "Deactivated"}
                </span>
                <div class="admin-account-actions">
                    <button class="primary-button" type="button" data-account-action="save">Save</button>
                    <button class="secondary-button" type="button" data-account-action="reset-password">Send password reset</button>
                    <button class="secondary-button" type="button"
                        data-account-action="${account.is_active ? "deactivate" : "activate"}">
                        ${account.is_active ? "Deactivate" : "Reactivate"}
                    </button>
                    <button class="delete-button" type="button" data-account-action="delete">Delete</button>
                </div>
            </div>
        </article>
    `).join("");
}

async function loadAdminAccounts() {
    if (!currentProfile || currentProfile.role !== "admin") return;

    const { data, error } = await dbClient
        .from("profiles")
        .select("id, email, full_name, admission_number, role, is_active")
        .in("role", ["student", "teacher"])
        .order("full_name", { ascending: true });

    if (error) throw error;
    managedAccounts = data || [];
    renderAdminAccounts();
}

async function requestAccountAction(action, accountId, values = {}) {
    const { data, error } = await dbClient.functions.invoke("manage-user", {
        body: { action, user_id: accountId, ...values }
    });

    if (error) throw error;
    if (data && data.error) throw new Error(data.error);
    return data;
}

async function handleAdminAccountAction(button) {
    const accountElement = button.closest("[data-account-id]");
    const account = managedAccounts.find(item => item.id === accountElement.dataset.accountId);
    const action = button.dataset.accountAction;
    if (!account) throw new Error("Account not found. Refresh the list and try again.");

    if (action === "delete" && !confirm(
        `Permanently delete ${account.full_name || account.email}? This also deletes their submissions and cannot be undone.`
    )) return;

    button.disabled = true;
    try {
        let result;
        if (action === "save") {
            const fullName = accountElement.querySelector('[name="full_name"]').value.trim();
            const email = accountElement.querySelector('[name="email"]').value.trim();
            const admissionNumber = accountElement.querySelector('[name="admission_number"]').value.trim();
            const role = accountElement.querySelector('[name="role"]').value;
            result = await requestAccountAction("update", account.id, {
                full_name: fullName,
                email,
                admission_number: admissionNumber,
                role
            });
        } else {
            result = await requestAccountAction(action, account.id);
        }

        await loadAdminAccounts();
        if (action === "reset-password") {
            showAdminAccountMessage(`Password reset email sent to ${account.email}.`);
        } else if (action === "delete") {
            showAdminAccountMessage("Account and linked submissions deleted.");
        } else if (action === "activate" || action === "deactivate") {
            showAdminAccountMessage(action === "activate" ? "Account reactivated." : "Account deactivated.");
        } else if (result.email_confirmation_pending) {
            showAdminAccountMessage("Details saved. The email change will finish after the user confirms the new address.");
        } else {
            showAdminAccountMessage("Account updated.");
        }
    } catch (error) {
        showAdminAccountMessage(error.message || "Account change failed.", true);
    } finally {
        button.disabled = false;
    }
}

function showAdmin() {
    if (!currentProfile || currentProfile.role !== "admin") {
        window.location.href = "signin.html?role=admin";
        return;
    }

    $("adminSection").hidden = false;
    $("adminSection").scrollIntoView({ behavior: "smooth" });
}

function hideAdmin() {
    $("adminSection").hidden = true;
    $("home").scrollIntoView({ behavior: "smooth" });
}

function clearFilters() {
    $("searchInput").value = "";
    $("subjectFilter").value = "";
    $("yearFilter").value = "";
    $("examFilter").value = "";
    renderPapers(libraryPapers);
}

function applyDashboardAccess() {
    $("studentDashboard").hidden = true;
    $("teacherDashboard").hidden = true;
    $("adminSection").hidden = true;
    $("signOutButton").hidden = !currentUser;

    if (!currentProfile) return;

    if (currentProfile.role === "student") $("studentDashboard").hidden = false;
    if (currentProfile.role === "teacher") $("teacherDashboard").hidden = false;
    if (currentProfile.role === "admin") $("adminSection").hidden = false;

    const targetByRole = {
        student: "studentDashboard",
        teacher: "teacherDashboard",
        admin: "adminSection"
    };

    const target = targetByRole[currentProfile.role];
    if (target && window.location.hash === `#${target}`) {
        $(target).scrollIntoView();
    }
}

function showFatalError(message) {
    const state = document.createElement("div");
    state.className = "empty-state";
    const title = document.createElement("strong");
    title.textContent = "Supabase connection is not ready";
    state.append(title, document.createTextNode(message));
    $("paperList").replaceChildren(state);
}

async function loadCurrentProfile() {
    const { data: sessionData, error: sessionError } =
        await dbClient.auth.getSession();

    if (sessionError) throw sessionError;
    if (!sessionData.session) return;

    const { data: userData, error: userError } = await dbClient.auth.getUser();
    if (userError) throw userError;
    currentUser = userData.user;

    if (!currentUser) return;

    const { data, error } = await dbClient
        .from("profiles")
        .select("id, email, full_name, admission_number, role, is_active")
        .eq("id", currentUser.id)
        .single();

    if (error) throw error;
    if (!data) throw new Error("Your Supabase profile could not be found.");
    if (!data.is_active) {
        await dbClient.auth.signOut();
        currentUser = null;
        currentProfile = null;
        throw new Error("This account has been deactivated. Contact an administrator.");
    }
    currentProfile = data;

    if (!["student", "teacher", "admin"].includes(currentProfile.role)) {
        throw new Error("Your account does not have a valid dashboard role.");
    }
}

async function signOut() {
    const { error } = await dbClient.auth.signOut();
    if (error) throw error;
    window.location.replace("index.html");
}

function bindEvents() {
    document.querySelectorAll("[data-dashboard-role]").forEach(link => {
        link.addEventListener("click", event => {
            const role = link.dataset.dashboardRole;
            const target = link.dataset.dashboardTarget;

            if (currentProfile && currentProfile.role === role) {
                event.preventDefault();
                $(target).scrollIntoView({ behavior: "smooth" });
                window.location.hash = target;
                return;
            }

            event.preventDefault();
            window.location.href =
                `signin.html?role=${encodeURIComponent(role)}`;
        });
    });

    $("adminToggle").addEventListener("click", showAdmin);
    $("closeAdmin").addEventListener("click", hideAdmin);
    $("refreshAdminAccounts").addEventListener("click", async () => {
        try {
            await loadAdminAccounts();
            showAdminAccountMessage("Account list refreshed.");
        } catch (error) {
            showAdminAccountMessage(error.message || "Could not load accounts.", true);
        }
    });
    $("adminAccountSearch").addEventListener("input", renderAdminAccounts);
    $("signOutButton").addEventListener("click", async () => {
        try {
            await signOut();
        } catch (error) {
            console.error(error);
            alert(`Sign out failed: ${error.message}`);
        }
    });
    $("uploadForm").addEventListener("submit", handleAdminUpload);
    $("studentUploadForm").addEventListener("submit", handleStudentUpload);

    $("studentLookupForm").addEventListener("submit", async event => {
        event.preventDefault();
        try {
            await loadOwnSubmissions($("lookupAdmission").value.trim());
        } catch (error) {
            console.error(error);
            $("studentSubmissionList").textContent =
                `Submissions could not be loaded: ${error.message}`;
        }
    });

    $("refreshSubmissions").addEventListener("click", async () => {
        try {
            await loadTeacherSubmissions();
        } catch (error) {
            console.error(error);
            $("teacherSubmissionList").textContent =
                `Submissions could not be loaded: ${error.message}`;
        }
    });

    $("teacherSearch").addEventListener("input", renderTeacherSubmissions);
    $("teacherSubjectFilter").addEventListener("change", renderTeacherSubmissions);
    $("searchInput").addEventListener("input", () => renderPapers(libraryPapers));
    for (const id of ["subjectFilter", "yearFilter", "examFilter"]) {
        $(id).addEventListener("change", () => renderPapers(libraryPapers));
    }

    $("clearFilters").addEventListener("click", clearFilters);
    $("closePreview").addEventListener("click", closePreview);
    $("closePreviewBottom").addEventListener("click", closePreview);
    $("previewModal").addEventListener("click", event => {
        if (event.target === $("previewModal")) closePreview();
    });

    document.addEventListener("keydown", event => {
        if (event.key === "Escape" && !$("previewModal").hidden) closePreview();
    });

    document.body.addEventListener("click", async event => {
        const accountButton = event.target.closest("button[data-account-action]");
        if (accountButton) {
            await handleAdminAccountAction(accountButton);
            return;
        }

        const button = event.target.closest("button[data-action]");
        if (!button) return;

        const action = button.dataset.action;
        const id = button.dataset.id;

        try {
            if (action === "preview") {
                previewPaper(id);
            } else if (action === "download") {
                await downloadPaper(id);
            } else if (action === "delete") {
                await deletePaper(id);
            } else if (action === "review-submission") {
                await reviewSubmission(id);
            } else if (action === "download-submission") {
                await downloadSubmission(
                    button.dataset.path,
                    button.dataset.fileName
                );
            }
        } catch (error) {
            console.error(error);
            alert(`The requested action could not be completed: ${error.message}`);
        }
    });
}

async function initialise() {
    $("currentYear").textContent = new Date().getFullYear();
    bindEvents();

    if (!dbClient) {
        showFatalError(
            SUPABASE_STATE
                ? SUPABASE_STATE.error
                : "Load and configure the Supabase client before using the library."
        );
        return;
    }

    try {
        await loadCurrentProfile();
        applyDashboardAccess();
        await refreshLibrary();

        if (currentProfile && currentProfile.role === "student") {
            await loadOwnSubmissions("");
        }

        if (currentProfile &&
            ["teacher", "admin"].includes(currentProfile.role)) {
            await loadTeacherSubmissions();
        }

        if (currentProfile && currentProfile.role === "admin") {
            try {
                await loadAdminAccounts();
            } catch (error) {
                showAdminAccountMessage(error.message || "Could not load accounts.", true);
            }
        }

    } catch (error) {
        console.error(error);
        showFatalError(`Could not load Supabase data: ${error.message}`);
    }
}

initialise();
