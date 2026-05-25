/**
 * task_queue.cpp — Implementation of the task queue system.
 *
 * Edge cases tested:
 *   - Scope-resolution operator (Class::method)
 *   - Constructor/destructor
 *   - Static member initialization
 *   - Multiple functions calling each other
 *   - C-style casts mixed with function calls
 *   - Deeply nested calls
 *   - String literals that look like function calls
 *   - Comments inside function bodies
 *   - Multi-line function signatures
 *   - Conditional compilation
 */
#include "task_queue.hpp"
#include <algorithm>
#include <iostream>
#include <chrono>
#include <cstdio>
#include <cassert>

// ── Conditional compilation edge case ────────────────────────
#ifdef _WIN32
#include <windows.h>
#endif

#ifndef NDEBUG
#include <cstdlib>
#endif

namespace tasklib {

// ── Static member initialization ─────────────────────────────
int Task::s_nextId = 0;

// ── Static method ────────────────────────────────────────────
int Task::generateId() {
    return ++s_nextId;
}

// ── Constructor with initializer list ────────────────────────
Task::Task(std::string name, Priority prio)
    : m_name(std::move(name))
    , m_priority(prio)
    , m_callback(nullptr)
    , m_result{0, "", 0.0}
{
    generateId();
}

// ── Destructor ───────────────────────────────────────────────
Task::~Task() {
    // cleanup — intentionally empty for edge case
}

// ── Method implementations ───────────────────────────────────
void Task::execute() {
    auto start = std::chrono::steady_clock::now();

    // Simulate work based on priority
    if (isHighPriority(m_priority)) {
        // High priority tasks get fast-tracked
        m_result.output = "fast:" + m_name;
    } else {
        m_result.output = "normal:" + m_name;
    }
    m_result.exitCode = 0;

    auto end = std::chrono::steady_clock::now();
    m_result.elapsed = std::chrono::duration<double>(end - start).count();

    notifyCallback(m_result.exitCode);
}

std::string Task::name() const {
    return m_name;
}

Priority Task::priority() const {
    return m_priority;
}

void Task::setCallback(TaskCallback cb) {
    m_callback = cb;
}

TaskResult Task::getResult() const {
    return m_result;
}

/* Operator< for priority comparison.
   Higher priority = "less than" so it sorts first. */
bool Task::operator<(const Task& other) const {
    return static_cast<int>(m_priority) > static_cast<int>(other.m_priority);
}

bool Task::operator==(const Task& other) const {
    return m_name == other.m_name && m_priority == other.m_priority;
}

void Task::notifyCallback(int status) {
    if (m_callback) {
        // Edge case: calling through function pointer
        m_callback(status, m_result.output.c_str());
    }
}

// ──────────────────────────────────────────────────────────────
//  TaskQueue implementation
// ──────────────────────────────────────────────────────────────
TaskQueue::TaskQueue(Strategy strategy)
    : m_strategy(strategy)
    , m_processed(0)
    , m_totalTime(0.0)
{
}

TaskQueue::~TaskQueue() {
    clear();
}

void TaskQueue::enqueue(std::unique_ptr<Task> task) {
    std::lock_guard<std::mutex> lock(m_mutex);
    m_tasks.push_back(std::move(task));
    if (m_strategy == Strategy::Priority) {
        sortByPriority();
    }
}

std::unique_ptr<Task> TaskQueue::dequeue() {
    std::lock_guard<std::mutex> lock(m_mutex);
    if (m_tasks.empty()) {
        return nullptr;  // Edge case: dequeue from empty queue
    }
    auto task = std::move(m_tasks.front());
    m_tasks.erase(m_tasks.begin());
    return task;
}

bool TaskQueue::empty() const {
    return m_tasks.empty();
}

size_t TaskQueue::size() const {
    return m_tasks.size();
}

void TaskQueue::clear() {
    std::lock_guard<std::mutex> lock(m_mutex);
    m_tasks.clear();
    m_processed = 0;
    m_totalTime = 0.0;
}

void TaskQueue::processAll() {
    while (!empty()) {
        auto task = dequeue();
        if (!task) break;  // Edge case: race condition guard

        task->execute();
        TaskResult result = task->getResult();

        m_totalTime += result.elapsed;
        m_processed++;

        if (!result.succeeded()) {
            fprintf(stderr, "Task '%s' failed with code %d\n",
                    task->name().c_str(), result.exitCode);
        }
    }
}

size_t TaskQueue::totalProcessed() const {
    return m_processed.load();
}

double TaskQueue::averageTime() const {
    size_t n = m_processed.load();
    return n > 0 ? m_totalTime / static_cast<double>(n) : 0.0;
}

void TaskQueue::sortByPriority() {
    std::sort(m_tasks.begin(), m_tasks.end(),
        [](const std::unique_ptr<Task>& a, const std::unique_ptr<Task>& b) {
            return *a < *b;
        });
}

Task* TaskQueue::findNext() {
    if (m_tasks.empty()) return nullptr;
    return m_tasks.front().get();
}

// ── Free functions ───────────────────────────────────────────

TaskQueue* createDefaultQueue(int numTasks) {
    auto* queue = new TaskQueue(TaskQueue::Strategy::Priority);

    for (int i = 0; i < numTasks; i++) {
        Priority p;
        if (i % 4 == 0)      p = Priority::Critical;
        else if (i % 3 == 0) p = Priority::High;
        else if (i % 2 == 0) p = Priority::Normal;
        else                  p = Priority::Low;

        auto task = std::make_unique<Task>(
            "task-" + std::to_string(i), p);
        queue->enqueue(std::move(task));
    }

    return queue;
}

void printReport(const TaskQueue& queue, const std::vector<TaskResult>& results) {
    printf("=== Task Report ===\n");
    printf("Processed: %zu\n", queue.totalProcessed());
    printf("Avg time:  %.6f s\n", queue.averageTime());

    int passed = 0;
    int failed = 0;
    for (const auto& r : results) {
        if (r.succeeded()) passed++;
        else failed++;
    }

    printf("Passed: %d, Failed: %d\n", passed, failed);
}

} // namespace tasklib

// ── Main entry point ─────────────────────────────────────────
int main(int argc, char* argv[]) {
    int numTasks = 10;
    if (argc > 1) {
        numTasks = atoi(argv[1]);
        numTasks = tasklib::clamp(numTasks, 1, MAX_TASKS);
    }

    auto* queue = tasklib::createDefaultQueue(numTasks);
    queue->processAll();

    // Edge case: empty vector of results for report
    std::vector<TaskResult> results;
    tasklib::printReport(*queue, results);

    delete queue;
    return 0;
}
