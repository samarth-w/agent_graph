/**
 * task_queue.hpp — Lock-free task queue with priority support.
 *
 * Edge cases tested:
 *   - Empty struct (no members)
 *   - Nested class inside namespace
 *   - Template functions
 *   - Operator overloading
 *   - Multiple inheritance
 *   - Forward declarations
 *   - Macros mixed with code
 *   - Enum class (scoped enum)
 *   - Typedef of function pointer
 *   - Static methods
 *   - Inline functions
 *   - Const methods
 *   - Pure virtual methods
 */
#pragma once

#include <vector>
#include <string>
#include <functional>
#include <memory>
#include <mutex>
#include <atomic>

// ── Forward declarations ─────────────────────────────────────
struct TaskResult;
class TaskRunner;

// ── Macros (should be skipped by parser) ─────────────────────
#define MAX_TASKS 1024
#define TASK_VERSION "1.0.0"
#define LOG(msg) do { fprintf(stderr, "%s\n", msg); } while(0)

// ── Empty struct edge case ───────────────────────────────────
struct Empty {};

// ── Enum class (C++11 scoped enum) ───────────────────────────
enum class Priority {
    Low,
    Normal,
    High,
    Critical
};

// ── Old-style enum ───────────────────────────────────────────
enum TaskState {
    PENDING,
    RUNNING,
    COMPLETED,
    FAILED
};

// ── Typedef of function pointer ──────────────────────────────
typedef void (*TaskCallback)(int status, const char* msg);

// ── Typedef of complex type ──────────────────────────────────
typedef std::vector<std::pair<std::string, int>> ScoreBoard;

// ── Struct with methods ──────────────────────────────────────
struct TaskResult {
    int exitCode;
    std::string output;
    double elapsed;

    bool succeeded() const {
        return exitCode == 0;
    }

    std::string summary() const {
        return output + " (exit=" + std::to_string(exitCode) + ")";
    }
};

namespace tasklib {

// ── Abstract base class with pure virtual ────────────────────
/** Base interface for all tasks. */
class ITask {
public:
    virtual ~ITask() = default;
    virtual void execute() = 0;
    virtual std::string name() const = 0;
    virtual Priority priority() const = 0;
};

// ── Concrete class with multiple inheritance ─────────────────
/**
 * Represents a single unit of work.
 * Inherits from ITask for polymorphism.
 */
class Task : public ITask {
public:
    Task(std::string name, Priority prio);
    ~Task() override;

    void execute() override;
    std::string name() const override;
    Priority priority() const override;

    void setCallback(TaskCallback cb);
    TaskResult getResult() const;

    // Operator overloading edge case
    bool operator<(const Task& other) const;
    bool operator==(const Task& other) const;

private:
    std::string m_name;
    Priority m_priority;
    TaskCallback m_callback;
    TaskResult m_result;

    // Static member function
    static int s_nextId;
    static int generateId();

    // Private helper
    void notifyCallback(int status);
};

// ── Template function edge case ──────────────────────────────
template<typename T>
T clamp(T value, T lo, T hi) {
    if (value < lo) return lo;
    if (value > hi) return hi;
    return value;
}

// ── Inline function ──────────────────────────────────────────
inline bool isHighPriority(Priority p) {
    return p == Priority::High || p == Priority::Critical;
}

// ── Class with nested enum ───────────────────────────────────
class TaskQueue {
public:
    enum class Strategy {
        FIFO,
        Priority,
        RoundRobin
    };

    explicit TaskQueue(Strategy strategy = Strategy::FIFO);
    ~TaskQueue();

    void enqueue(std::unique_ptr<Task> task);
    std::unique_ptr<Task> dequeue();
    bool empty() const;
    size_t size() const;
    void clear();

    // Process all tasks
    void processAll();

    // Statistics
    size_t totalProcessed() const;
    double averageTime() const;

private:
    std::vector<std::unique_ptr<Task>> m_tasks;
    Strategy m_strategy;
    std::mutex m_mutex;
    std::atomic<size_t> m_processed;
    double m_totalTime;

    void sortByPriority();
    Task* findNext();
};

// ── Free function that ties things together ──────────────────
/// Create a queue, populate it, and run everything.
TaskQueue* createDefaultQueue(int numTasks);

/// Report results to stdout.
void printReport(const TaskQueue& queue, const std::vector<TaskResult>& results);

} // namespace tasklib
