module.exports = function (eleventyConfig) {
  // ассеты
  eleventyConfig.addPassthroughCopy("src/assets");
  eleventyConfig.addWatchTarget("src/assets");

  // ===== Фильтры дат =====
  eleventyConfig.addFilter("readableDate", (d) =>
    new Date(d).toLocaleDateString("ru-RU", {
      year: "numeric",
      month: "long",
      day: "numeric",
    })
  );



  eleventyConfig.addFilter("htmlDateString", (d) => {
    const dt = new Date(d);
    return dt.toISOString().split("T")[0]; // YYYY-MM-DD
  });

  eleventyConfig.addFilter("yearNow", () => new Date().getFullYear());

  // ===== Слаг для тегов =====
  eleventyConfig.addFilter("slug", (str) =>
    String(str || "")
      .toLowerCase()
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^\w\-а-яё]/gi, "")
      .replace(/\-+/g, "-")
  );

  // ===== Коллекции =====
  // Коллекция постов по папке (если используешь collections.posts на главной)
  eleventyConfig.addCollection("posts", (api) =>
    api
      .getFilteredByGlob("src/posts/**/*.md")
      .sort((a, b) => b.date - a.date)
  );

  // Список тегов (без служебных), для /tags
  eleventyConfig.addCollection("tagList", (api) => {
    const skip = new Set(["all", "posts"]);
    const counts = new Map();
    api.getAll().forEach((item) => {
      (item.data.tags || []).forEach((t) => {
        if (!skip.has(t)) counts.set(t, (counts.get(t) || 0) + 1);
      });
    });
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([t]) => t);
  });

  // БАЗОВЫЙ URL домена для абсолютных ссылок (About на корень)
  eleventyConfig.addGlobalData("baseUrl", "https://ser017.ru");

  return {
    dir: { input: "src", includes: "_includes", data: "_data", output: "_site" },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
    templateFormats: ["md", "njk", "html"],
  };






};

