export interface QuestionTabState {
  activeTab: number;
  slideDirection: number;
}

export function reduceQuestionTab(state: QuestionTabState, nextTab: number): QuestionTabState {
  if (nextTab === state.activeTab) return state;
  return {
    activeTab: nextTab,
    slideDirection: nextTab > state.activeTab ? 1 : -1,
  };
}
