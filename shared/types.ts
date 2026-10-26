export type Role = 'admin' | 'contributor' | 'student'
export type Difficulty = 'easy' | 'medium' | 'hard'
export type QuestionStatus = 'draft' | 'pending' | 'published' | 'rejected'
export interface User { id: string; name: string; email: string; username?: string; role: Role; createdAt: string }
export interface Chapter { id: string; name: string; shortName: string; description: string; color: string; icon: string }
export interface Question { id: string; chapterId: string; difficulty: Difficulty; prompt: string; options: string[]; correctAnswers: number[]; explanation: string; image: string | null; status: QuestionStatus; authorId: string; createdAt: string; updatedAt: string; reviewNote?: string }
export type PublicQuestion = Omit<Question, 'correctAnswers' | 'explanation' | 'authorId' | 'reviewNote'>
export interface QuestionInput { chapterId: string; difficulty: Difficulty; prompt: string; options: string[]; correctAnswers: number[]; explanation: string; image: string | null; status: 'draft' | 'pending' }
export interface AnswerResult { questionId: string; selected: number[]; correctAnswers: number[]; explanation: string; correct: boolean; points: number; elapsedMs: number }
export interface GameState { id: string; mode: 'solo' | 'multi'; code?: string; status: 'waiting' | 'playing' | 'finished'; phase: 'question' | 'correction'; chapterIds: string[]; hostId: string; questionIndex: number; totalQuestions: number; question: PublicQuestion | null; deadline: number | null; serverNow: number; players: { id: string; name: string; score: number; answered: boolean; connected: boolean }[]; result: AnswerResult | null; results: AnswerResult[] }
export interface LeaderboardRow { userId: string; name: string; points: number; accuracy: number; answered: number; rank: number }
export interface Progress { totalPoints: number; answered: number; correct: number; accuracy: number; gamesPlayed: number; streak: number; chapters: { chapterId: string; answered: number; correct: number; points: number }[]; recentGames: { id: string; mode: string; score: number; total: number; correct: number; createdAt: string }[]; mistakes: { questionId: string; prompt: string; chapterId: string; count: number }[]; daily: { date: string; answered: number }[] }
export interface Bootstrap { user: User; chapters: Chapter[]; counts: Record<string, number>; progress: Progress }
