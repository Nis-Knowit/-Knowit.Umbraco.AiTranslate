namespace Knowit.Umbraco.AiTranslate.Controllers;

public sealed record TranslationNodeDto(
    Guid Id,
    int IntId,
    int ParentId,
    int Level,
    int SortOrder,
    string Name,
    string ContentTypeAlias,
    int TranslatableProperties,
    IReadOnlyList<string> CulturesWithContent);
